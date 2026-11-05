/// <reference lib="dom" />

// The visual editor that runs inside the preview page. The bridge loads it only while the window has visual editing
// on, so a page pays nothing otherwise. The proxy serves `editor`'s own source text, so the function must stay fully
// self-contained: no imports, no references to anything else in this module.
//
// Protocol v1. The page posts `omai:visual:loaded | ready | select | change | ask | image | error`; the window sends
// `omai:visual:command` with one command. The window side (gui-plugins preview/visual/protocol.ts) decodes and types
// every message; this side only accepts messages from the parent origin and checks each command's fields.

/** The editor's script for pages entered from `parentOrigin`; without one it does nothing. */
export function visualScript(parentOrigin: string | undefined) {
  return `(${editor.toString()})(${JSON.stringify(parentOrigin ?? null)});`
}

/** Runs in the preview page. Only posts to `parentOrigin` and only obeys messages from it. */
export function editor(parentOrigin: string | null): void {
  if (!parentOrigin || window.parent === window) return
  // Framework internals the editor reads for source locations, typed by the fields it uses.
  type Fiber = {
    _debugSource?: { fileName?: string; lineNumber?: number; columnNumber?: number }
    type?: { displayName?: string; name?: string } | string | null
    return?: Fiber | null
  }
  type Internals = {
    __omaiVisual?: boolean
    __vueParentComponent?: { type?: { __file?: string; name?: string; __name?: string } }
    __svelte_meta?: { loc?: { file?: string; line?: number; column?: number } }
    [key: string]: unknown
  }
  const installed = window as unknown as Internals

  if (installed.__omaiVisual) return
  installed.__omaiVisual = true

  const STYLE_KEYS = [
    "color", "background-color", "background-image", "font-family", "font-size", "font-weight", "line-height",
    "letter-spacing", "text-align", "margin-top", "margin-right", "margin-bottom", "margin-left", "padding-top",
    "padding-right", "padding-bottom", "padding-left", "width", "height", "min-width", "max-width", "border-width",
    "border-style", "border-color", "border-radius", "display", "flex-direction", "flex-wrap", "gap", "align-items",
    "justify-content", "opacity", "box-shadow",
  ]
  const ATTRS = ["src", "href", "alt", "name", "type", "role", "aria-label"]
  const EDITABLE_ATTRS = ["src", "alt", "href", "title"]
  const LABELS: Record<string, string> = {
    h1: "Heading", h2: "Heading", h3: "Heading", h4: "Heading", h5: "Heading", h6: "Heading", p: "Text",
    span: "Text", strong: "Text", em: "Text", a: "Link", button: "Button", img: "Image", svg: "Icon", input: "Input",
    textarea: "Input", select: "Select", label: "Label", ul: "List", ol: "List", li: "List item", nav: "Navigation",
    header: "Header", footer: "Footer", section: "Section", article: "Article", aside: "Sidebar", main: "Main",
    form: "Form", div: "Box", figure: "Figure", video: "Video", table: "Table",
  }
  const BRAND = "#1a64d6"

  type Fingerprint = {
    tag: string
    id?: string
    classes: string[]
    text?: string
    attrs: Record<string, string>
    index: number
  }
  type Change = {
    path: string
    fingerprint: Fingerprint
    kind: "style" | "text" | "attribute" | "move"
    property?: string
    before: string
    after: string
    html?: string
  }
  type Original = { styles: Map<string, string>; attrs: Map<string, string | null>; html?: string }

  const state: {
    enabled: boolean
    selected?: Element
    hovered?: Element
    editing?: { element: HTMLElement; html: string; text: string }
    drag?: { element: Element; x: number; y: number; moved: boolean; target?: { element: Element; after: boolean } }
    resize?: { element: HTMLElement; x: number; y: number; width: number; height: number; before: Record<string, string>; edge: string }
    labels: Record<string, string>
    abort?: AbortController
    observer?: MutationObserver
    frame?: number
    host?: HTMLElement
    ui?: {
      hover: HTMLElement
      tag: HTMLElement
      selection: HTMLElement
      toolbar: HTMLElement
      drop: HTMLElement
    }
  } = { enabled: false, labels: {} }
  const originals = new WeakMap<Element, Original>()

  const post = (message: Record<string, unknown>) => window.parent.postMessage({ ...message, v: 1 }, parentOrigin)
  const text = (value: unknown, max: number): value is string => typeof value === "string" && value.length <= max
  const clean = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, " ").trim()
  const isUi = (node: EventTarget | null) => !!state.host && node instanceof Node && state.host.contains(node)

  // A CSS path that resolves back to the element: ids where unique, else tag with :nth-of-type.
  const pathOf = (element: Element): string => {
    const parts: string[] = []
    let current: Element | null = element

    while (current && current !== document.body && current !== document.documentElement && parts.length < 16) {
      if (current.id && document.querySelectorAll(`#${CSS.escape(current.id)}`).length === 1) {
        parts.unshift(`#${CSS.escape(current.id)}`)
        return parts.join(" > ")
      }
      const tag = current.tagName.toLowerCase()
      const parent: Element | null = current.parentElement
      const same = parent ? Array.from(parent.children).filter((child) => child.tagName === current!.tagName) : []
      parts.unshift(same.length > 1 ? `${tag}:nth-of-type(${same.indexOf(current) + 1})` : tag)
      current = parent
    }
    parts.unshift("body")

    return parts.join(" > ")
  }

  const siblingIndex = (element: Element) =>
    element.parentElement ? Array.from(element.parentElement.children).indexOf(element) + 1 : 1

  const fingerprintOf = (element: Element): Fingerprint => {
    const attrs: Record<string, string> = {}
    ATTRS.forEach((name) => {
      const value = element.getAttribute(name)

      if (value && value.length <= 512) attrs[name] = value
    })
    const content = clean(element.textContent).slice(0, 120)

    return {
      tag: element.tagName.toLowerCase(),
      id: element.id || undefined,
      classes: Array.from(element.classList).slice(0, 20),
      text: content || undefined,
      attrs,
      index: siblingIndex(element),
    }
  }

  // The element a recorded path names when it still matches its fingerprint, else the closest match by fingerprint.
  const find = (path: string, fingerprint: Fingerprint): Element | undefined => {
    const score = (element: Element) =>
      (element.tagName.toLowerCase() === fingerprint.tag ? 1 : -10) +
      (fingerprint.id && element.id === fingerprint.id ? 5 : 0) +
      fingerprint.classes.filter((name) => element.classList.contains(name)).length +
      (fingerprint.text && clean(element.textContent).slice(0, 120) === fingerprint.text ? 3 : 0) +
      Object.entries(fingerprint.attrs).filter(([name, value]) => element.getAttribute(name) === value).length * 2
    const direct = (() => {
      try {
        return document.querySelector(path) ?? undefined
      } catch {
        return undefined
      }
    })()

    if (direct && score(direct) >= 2) return direct
    let best: { element: Element; score: number } | undefined
    document.querySelectorAll(fingerprint.tag).forEach((element) => {
      if (isUi(element)) return
      const value = score(element)

      if (value >= 3 && (!best || value > best.score)) best = { element, score: value }
    })

    return best?.element
  }

  const sourceOf = (element: Element) => {
    const astro = element.closest("[data-astro-source-file]")

    if (astro) {
      const [line, column] = (astro.getAttribute("data-astro-source-loc") ?? "").split(":").map(Number)
      return { file: astro.getAttribute("data-astro-source-file") ?? undefined, line: line || undefined, column: column || undefined }
    }
    const inspected = element.closest("[data-insp-path]")

    if (inspected)
      return {
        file: inspected.getAttribute("data-insp-path") ?? undefined,
        line: Number(inspected.getAttribute("data-insp-row")) || undefined,
        column: Number(inspected.getAttribute("data-insp-col")) || undefined,
      }
    const internals = element as unknown as Internals
    const fiberKey = Object.keys(element).find((key) => key.startsWith("__reactFiber$"))

    if (fiberKey) {
      let fiber = internals[fiberKey] as Fiber | null | undefined
      let source: Fiber["_debugSource"]
      let component: string | undefined

      for (let depth = 0; fiber && depth < 40 && (!source || !component); depth++) {
        source ??= fiber._debugSource
        const type = fiber.type

        if (!component && type && typeof type !== "string" && (type.displayName || type.name))
          component = type.displayName || type.name
        fiber = fiber.return
      }

      if (source || component)
        return { file: source?.fileName, line: source?.lineNumber, column: source?.columnNumber, component }
    }
    let vue: Element | null = element

    while (vue && !(vue as unknown as Internals).__vueParentComponent) vue = vue.parentElement
    const instance = vue ? (vue as unknown as Internals).__vueParentComponent : undefined

    if (instance?.type) return { file: instance.type.__file, component: instance.type.name || instance.type.__name }
    const svelte = internals.__svelte_meta

    if (svelte?.loc) return { file: svelte.loc.file, line: svelte.loc.line, column: svelte.loc.column }

    return undefined
  }

  const labelOf = (element: Element) => {
    const tag = element.tagName.toLowerCase()

    return LABELS[tag] ?? tag
  }

  const isText = (element: Element) =>
    Array.from(element.childNodes).some((node) => node.nodeType === Node.TEXT_NODE && clean(node.textContent) !== "")

  const plainText = (element: Element) => element.children.length === 0

  const infoOf = (element: Element) => {
    const computed = getComputedStyle(element)
    const styles: Record<string, string> = {}
    STYLE_KEYS.forEach((key) => {
      styles[key] = computed.getPropertyValue(key)
    })
    const rect = element.getBoundingClientRect()
    const display = computed.getPropertyValue("display")
    const breadcrumb: { label: string; path: string }[] = []
    let current: Element | null = element

    while (current && current !== document.body && breadcrumb.length < 8) {
      breadcrumb.unshift({ label: labelOf(current), path: pathOf(current) })
      current = current.parentElement
    }
    const tag = element.tagName.toLowerCase()

    return {
      path: pathOf(element),
      fingerprint: fingerprintOf(element),
      label: labelOf(element),
      tag,
      text: plainText(element) ? clean(element.textContent).slice(0, 2000) : undefined,
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      styles,
      isText: isText(element),
      plainText: plainText(element),
      isImage: tag === "img",
      src: tag === "img" ? element.getAttribute("src") ?? undefined : undefined,
      // The resolved address, so the window can show the image: a relative src means nothing outside the page.
      srcUrl: tag === "img" ? (element as HTMLImageElement).src || undefined : undefined,
      alt: tag === "img" ? element.getAttribute("alt") ?? undefined : undefined,
      href: tag === "a" ? element.getAttribute("href") ?? undefined : undefined,
      layout: display.includes("flex") ? "flex" : display.includes("grid") ? "grid" : display.startsWith("inline") ? "inline" : "block",
      breadcrumb,
      source: sourceOf(element),
    }
  }

  const original = (element: Element) => {
    const existing = originals.get(element)

    if (existing) return existing
    const created: Original = { styles: new Map(), attrs: new Map() }
    originals.set(element, created)

    return created
  }

  const report = (element: Element, change: Omit<Change, "path" | "fingerprint">) => {
    post({ type: "omai:visual:change", change: { path: pathOf(element), fingerprint: fingerprintOf(element), ...change } })
    if (state.selected === element) post({ type: "omai:visual:select", element: infoOf(element) })
  }

  const setStyle = (element: Element, property: string, value: string) => {
    const html = element as HTMLElement
    const kept = original(element).styles

    if (!kept.has(property)) kept.set(property, html.style.getPropertyValue(property))
    html.style.setProperty(property, value)
  }

  const setAttr = (element: Element, name: string, value: string) => {
    const kept = original(element).attrs

    if (!kept.has(name)) kept.set(name, element.getAttribute(name))
    element.setAttribute(name, value)
    if (name === "src" && element.tagName === "IMG") responsiveParts(element).forEach(([part, attr]) => setAside(part, attr))
  }

  // A responsive image shows what its srcset (or its <picture>'s sources) picks, never src; a replaced image sets
  // those aside so the new src is what shows, and a revert of the src puts them back.
  const responsiveParts = (image: Element): [Element, string][] => [
    [image, "srcset"],
    [image, "sizes"],
    ...(image.parentElement?.tagName === "PICTURE"
      ? Array.from(image.parentElement.querySelectorAll(":scope > source")).map((source): [Element, string] => [source, "srcset"])
      : []),
  ]

  const setAside = (element: Element, attr: string) => {
    const kept = original(element).attrs

    if (!kept.has(attr)) kept.set(attr, element.getAttribute(attr))
    element.removeAttribute(attr)
  }

  const restore = (element: Element, attr: string) => {
    const kept = originals.get(element)?.attrs

    if (!kept?.has(attr)) return
    const before = kept.get(attr)
    kept.delete(attr)

    if (before === null || before === undefined) element.removeAttribute(attr)
    else element.setAttribute(attr, before)
  }

  const setText = (element: Element, value: string, html?: string) => {
    const kept = original(element)
    kept.html ??= element.innerHTML

    if (html !== undefined) element.innerHTML = html
    else element.textContent = value
  }

  const moveTo = (element: Element, index: number) => {
    const parent = element.parentElement

    if (!parent) return
    const others = Array.from(parent.children).filter((child) => child !== element)
    parent.insertBefore(element, others[index - 1] ?? null)
  }

  // Applies a recorded change without reporting it: a reload re-creating pending edits, or undo.
  const applyChange = (change: Change, value: string, html?: string) => {
    const element = find(change.path, change.fingerprint)

    if (!element) return
    if (change.kind === "style" && change.property) setStyle(element, change.property, value)
    if (change.kind === "attribute" && change.property) setAttr(element, change.property, value)
    if (change.kind === "text") setText(element, value, html)
    if (change.kind === "move") moveTo(element, Number(value))
  }

  const revertChange = (change: Change) => {
    const element = find(change.path, change.fingerprint)

    if (!element) return
    const kept = originals.get(element)

    if (change.kind === "style" && change.property) {
      const before = kept?.styles.get(change.property)
      ;(element as HTMLElement).style.setProperty(change.property, before ?? "")
      kept?.styles.delete(change.property)
    }
    if (change.kind === "attribute" && change.property) {
      const before = kept?.attrs.get(change.property)

      if (before === null || before === undefined) element.removeAttribute(change.property)
      else element.setAttribute(change.property, before)
      kept?.attrs.delete(change.property)
      if (change.property === "src" && element.tagName === "IMG")
        responsiveParts(element).forEach(([part, attr]) => restore(part, attr))
    }
    if (change.kind === "text" && kept?.html !== undefined) {
      element.innerHTML = kept.html
      kept.html = undefined
    }
    if (change.kind === "move") moveTo(element, Number(change.before))
    if (state.selected === element) post({ type: "omai:visual:select", element: infoOf(element) })
  }

  // ---- The overlay: one fixed host with a shadow root, so the page's CSS can't restyle it.

  const createUi = () => {
    const host = document.createElement("div")
    host.setAttribute("data-omai-visual-ui", "")
    host.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:2147483647"
    const root = host.attachShadow({ mode: "open" })
    root.innerHTML = `<style>
      .box{position:fixed;box-sizing:border-box;pointer-events:none;display:none}
      .hover{border:1px solid ${BRAND}}
      .tag{position:fixed;display:none;padding:1px 6px;border-radius:4px;background:${BRAND};color:#fff;font:500 11px/16px system-ui,sans-serif;white-space:nowrap}
      .selection{border:2px solid ${BRAND}}
      .handle{position:absolute;width:8px;height:8px;margin:-4px 0 0 -4px;background:#fff;border:1.5px solid ${BRAND};border-radius:2px;pointer-events:auto;box-sizing:border-box}
      .toolbar{position:fixed;display:none;gap:2px;padding:3px;border-radius:8px;background:#111827;box-shadow:0 4px 14px rgb(0 0 0/.25);pointer-events:auto}
      .toolbar button{all:unset;display:grid;place-items:center;width:26px;height:26px;border-radius:6px;color:#e5e7eb;cursor:pointer}
      .toolbar button:hover{background:rgb(255 255 255/.12)}
      .toolbar svg{width:15px;height:15px}
      .drop{position:fixed;display:none;background:${BRAND};border-radius:1px;pointer-events:none}
      [contenteditable]{outline:none}
    </style>
    <div class="box hover"></div><div class="tag"></div>
    <div class="box selection">${["nw", "n", "ne", "e", "se", "s", "sw", "w"]
      .map((edge) => `<span class="handle" data-edge="${edge}" style="left:${edge.includes("w") ? 0 : edge.includes("e") ? 100 : 50}%;top:${edge.includes("n") ? 0 : edge.includes("s") ? 100 : 50}%;cursor:${edge}-resize"></span>`)
      .join("")}</div>
    <div class="toolbar" role="toolbar"></div><div class="drop"></div>`
    document.documentElement.appendChild(host)
    const pick = (selector: string) => root.querySelector(selector) as HTMLElement

    state.host = host
    state.ui = {
      hover: pick(".hover"),
      tag: pick(".tag"),
      selection: pick(".selection"),
      toolbar: pick(".toolbar"),
      drop: pick(".drop"),
    }
  }

  const ICONS: Record<string, string> = {
    parent: '<path d="M8 13V4M4 8l4-4 4 4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>',
    edit: '<path d="M3 13h2.5L12 6.5 9.5 4 3 10.5V13zM9.5 4L12 6.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>',
    image: '<rect x="2.5" y="3" width="11" height="10" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M3 11l3-3 2.5 2.5L10.5 9 13 11.5" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>',
    ask: '<path d="M8 2.5l1.2 3.3L12.5 7l-3.3 1.2L8 11.5 6.8 8.2 3.5 7l3.3-1.2zM12 11l.5 1.5L14 13l-1.5.5L12 15l-.5-1.5L10 13l1.5-.5z" fill="currentColor"/>',
    deselect: '<path d="M4.5 4.5l7 7M11.5 4.5l-7 7" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>',
  }

  const renderToolbar = (element: Element) => {
    const toolbar = state.ui!.toolbar
    const actions = ["parent", ...(isText(element) ? ["edit"] : []), ...(element.tagName === "IMG" ? ["image"] : []), "ask", "deselect"]
    toolbar.innerHTML = actions
      .map((action) => `<button type="button" data-action="${action}" title="${(state.labels[action] ?? action).replace(/"/g, "&quot;")}" aria-label="${(state.labels[action] ?? action).replace(/"/g, "&quot;")}"><svg viewBox="0 0 16 16">${ICONS[action]}</svg></button>`)
      .join("")
  }

  const place = (box: HTMLElement, rect: DOMRect) => {
    box.style.display = "block"
    box.style.left = `${rect.left}px`
    box.style.top = `${rect.top}px`
    box.style.width = `${rect.width}px`
    box.style.height = `${rect.height}px`
  }

  const draw = () => {
    state.frame = undefined
    const ui = state.ui

    if (!ui) return
    const hovered = state.hovered && state.hovered !== state.selected && state.hovered.isConnected ? state.hovered : undefined

    if (hovered && !state.drag) {
      const rect = hovered.getBoundingClientRect()
      place(ui.hover, rect)
      ui.tag.style.display = "block"
      ui.tag.textContent = `${labelOf(hovered)} ${Math.round(rect.width)}×${Math.round(rect.height)}`
      ui.tag.style.left = `${rect.left}px`
      ui.tag.style.top = `${Math.max(0, rect.top - 20)}px`
    } else {
      ui.hover.style.display = "none"
      ui.tag.style.display = "none"
    }
    const selected = state.selected?.isConnected ? state.selected : undefined

    if (selected && !state.editing) {
      const rect = selected.getBoundingClientRect()
      place(ui.selection, rect)
      ui.toolbar.style.display = "flex"
      const above = rect.top - 36

      ui.toolbar.style.left = `${Math.max(4, rect.left)}px`
      ui.toolbar.style.top = `${above >= 4 ? above : rect.bottom + 6}px`
    } else {
      ui.selection.style.display = "none"
      ui.toolbar.style.display = "none"
    }
    const target = state.drag?.moved ? state.drag.target : undefined

    if (target) {
      const rect = target.element.getBoundingClientRect()
      const row = getComputedStyle(target.element.parentElement ?? document.body).getPropertyValue("flex-direction").startsWith("row")
        && getComputedStyle(target.element.parentElement ?? document.body).getPropertyValue("display").includes("flex")

      ui.drop.style.display = "block"
      if (row) {
        ui.drop.style.left = `${(target.after ? rect.right : rect.left) - 1}px`
        ui.drop.style.top = `${rect.top}px`
        ui.drop.style.width = "2px"
        ui.drop.style.height = `${rect.height}px`
      } else {
        ui.drop.style.left = `${rect.left}px`
        ui.drop.style.top = `${(target.after ? rect.bottom : rect.top) - 1}px`
        ui.drop.style.width = `${rect.width}px`
        ui.drop.style.height = "2px"
      }
    } else ui.drop.style.display = "none"
  }

  const schedule = () => {
    if (state.frame !== undefined) return
    state.frame = requestAnimationFrame(draw)
  }

  // ---- Selection and editing

  const select = (element: Element | undefined) => {
    finishEditing(true)
    state.selected = element

    if (element) renderToolbar(element)
    post({ type: "omai:visual:select", element: element ? infoOf(element) : null })
    schedule()
  }

  const startEditing = (element: HTMLElement) => {
    if (!isText(element)) return
    if (state.selected !== element) select(element)
    state.editing = { element, html: element.innerHTML, text: clean(element.textContent) }
    element.setAttribute("contenteditable", "true")
    element.focus()
    schedule()
  }

  function finishEditing(commit: boolean) {
    const editing = state.editing

    if (!editing) return
    state.editing = undefined
    editing.element.removeAttribute("contenteditable")

    if (!commit) {
      editing.element.innerHTML = editing.html
      schedule()
      return
    }
    const after = clean(editing.element.textContent)

    if (after !== editing.text) {
      original(editing.element).html ??= editing.html
      report(editing.element, { kind: "text", before: editing.text, after, html: editing.element.innerHTML })
    }
    schedule()
  }

  const target = (event: Event) => {
    const node = event.target

    if (!(node instanceof Element) || isUi(node)) return undefined
    if (node === document.body || node === document.documentElement) return undefined

    return node.closest("svg") ?? node
  }

  // Where a dragged element would land: before or after the sibling under the pointer.
  const dropTarget = (element: Element, x: number, y: number) => {
    const parent = element.parentElement

    if (!parent) return undefined
    const under = document.elementsFromPoint(x, y).find((node) => node !== element && node.parentElement === parent && !isUi(node))

    if (!under) return undefined
    const rect = under.getBoundingClientRect()
    const row = getComputedStyle(parent).getPropertyValue("display").includes("flex")
      && getComputedStyle(parent).getPropertyValue("flex-direction").startsWith("row")

    return { element: under, after: row ? x > rect.left + rect.width / 2 : y > rect.top + rect.height / 2 }
  }

  const onPointerDown = (event: PointerEvent) => {
    const path = event.composedPath()
    const handle = path.find((node) => node instanceof HTMLElement && node.dataset.edge) as HTMLElement | undefined
    const selected = state.selected as HTMLElement | undefined

    if (handle && selected) {
      const rect = selected.getBoundingClientRect()
      state.resize = {
        element: selected,
        x: event.clientX,
        y: event.clientY,
        width: rect.width,
        height: rect.height,
        before: { width: getComputedStyle(selected).width, height: getComputedStyle(selected).height },
        edge: handle.dataset.edge ?? "se",
      }
      event.preventDefault()
      event.stopPropagation()
      return
    }
    if (isUi(event.target) || state.editing || !selected || target(event) !== selected || event.button !== 0) return
    state.drag = { element: selected, x: event.clientX, y: event.clientY, moved: false }
  }

  const onPointerMove = (event: PointerEvent) => {
    const resize = state.resize

    if (resize) {
      const dx = event.clientX - resize.x
      const dy = event.clientY - resize.y
      const width = resize.width + (resize.edge.includes("e") ? dx : resize.edge.includes("w") ? -dx : 0)
      const height = resize.height + (resize.edge.includes("s") ? dy : resize.edge.includes("n") ? -dy : 0)

      if (resize.edge !== "n" && resize.edge !== "s") setStyle(resize.element, "width", `${Math.max(1, Math.round(width))}px`)
      if (resize.edge !== "e" && resize.edge !== "w") setStyle(resize.element, "height", `${Math.max(1, Math.round(height))}px`)
      schedule()
      return
    }
    const drag = state.drag

    if (!drag) return
    if (!drag.moved && Math.abs(event.clientX - drag.x) + Math.abs(event.clientY - drag.y) < 5) return
    drag.moved = true
    drag.target = dropTarget(drag.element, event.clientX, event.clientY)
    event.preventDefault()
    schedule()
  }

  const onPointerUp = () => {
    const resize = state.resize

    if (resize) {
      state.resize = undefined
      ;(["width", "height"] as const).forEach((property) => {
        const after = resize.element.style.getPropertyValue(property)

        if (after && after !== resize.before[property])
          report(resize.element, { kind: "style", property, before: resize.before[property] ?? "", after })
      })
      return
    }
    const drag = state.drag
    state.drag = undefined

    if (!drag?.moved || !drag.target) return schedule()
    const before = siblingIndex(drag.element)
    const parent = drag.element.parentElement!
    parent.insertBefore(drag.element, drag.target.after ? drag.target.element.nextElementSibling : drag.target.element)
    const after = siblingIndex(drag.element)

    if (after !== before) report(drag.element, { kind: "move", before: String(before), after: String(after) })
    schedule()
  }

  const onToolbar = (event: Event) => {
    const button = event.composedPath().find((node) => node instanceof HTMLElement && node.dataset.action) as HTMLElement | undefined
    const selected = state.selected

    if (!button || !selected) return
    event.preventDefault()
    event.stopPropagation()
    const action = button.dataset.action

    if (action === "parent" && selected.parentElement && selected.parentElement !== document.body) select(selected.parentElement)
    if (action === "edit") startEditing(selected as HTMLElement)
    if (action === "image") post({ type: "omai:visual:image", element: infoOf(selected) })
    if (action === "ask") post({ type: "omai:visual:ask", element: infoOf(selected) })
    if (action === "deselect") select(undefined)
  }

  // Colours and fonts the page already uses, for the inspector's swatches and font list.
  const palette = () => {
    const counts = new Map<string, number>()
    const families = new Map<string, number>()
    const elements = Array.from(document.body.querySelectorAll("*")).slice(0, 600)
    elements.forEach((element) => {
      if (isUi(element)) return
      const computed = getComputedStyle(element)
      if (computed.fontFamily) families.set(computed.fontFamily, (families.get(computed.fontFamily) ?? 0) + 1)
      ;[computed.color, computed.backgroundColor].forEach((value) => {
        if (!value || value === "transparent" || /rgba\(.*,\s*0\)$/.test(value)) return
        counts.set(value, (counts.get(value) ?? 0) + 1)
      })
    })
    const colors = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]).slice(0, 24).map(([value]) => value)
    // The families the page's elements use, most used first, then any web font it loads but hasn't used yet.
    const fonts = new Set<string>(Array.from(families.entries()).sort((a, b) => b[1] - a[1]).map(([value]) => value))
    const bodyFont = getComputedStyle(document.body).fontFamily

    if (bodyFont) fonts.add(bodyFont)
    try {
      document.fonts?.forEach((face) => fonts.add(face.family.replace(/^["']|["']$/g, "")))
    } catch {}

    return { colors, fonts: Array.from(fonts).slice(0, 40) }
  }

  const enable = (labels: unknown) => {
    if (labels && typeof labels === "object")
      Object.entries(labels).forEach(([key, value]) => {
        if (text(value, 80)) state.labels[key] = value
      })
    if (state.enabled) return
    state.enabled = true
    const abort = new AbortController()
    const options = { capture: true, signal: abort.signal }
    state.abort = abort
    createUi()
    state.ui!.toolbar.addEventListener("click", onToolbar, { signal: abort.signal })

    document.addEventListener(
      "mouseover",
      (event) => {
        const element = target(event)

        if (element === state.hovered) return
        state.hovered = element
        schedule()
      },
      options,
    )
    document.addEventListener(
      "mouseout",
      (event) => {
        if (event.relatedTarget) return
        state.hovered = undefined
        schedule()
      },
      options,
    )
    document.addEventListener(
      "click",
      (event) => {
        if (isUi(event.target)) return
        const element = target(event)

        if (state.editing && element && state.editing.element.contains(element)) return
        event.preventDefault()
        event.stopImmediatePropagation()

        if (element) select(element)
      },
      options,
    )
    document.addEventListener(
      "dblclick",
      (event) => {
        const element = target(event)

        if (!(element instanceof HTMLElement)) return
        event.preventDefault()
        event.stopImmediatePropagation()
        startEditing(element)
      },
      options,
    )
    document.addEventListener("submit", (event) => event.preventDefault(), options)
    document.addEventListener(
      "keydown",
      (event) => {
        if (state.editing) {
          if (event.key === "Escape") {
            event.preventDefault()
            finishEditing(false)
          }
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault()
            finishEditing(true)
          }
          return
        }
        if (event.key === "Escape" && state.selected) {
          event.preventDefault()
          select(undefined)
        }
        if (event.altKey && (event.key === "ArrowUp" || event.key === "ArrowDown") && state.selected) {
          event.preventDefault()
          command({ name: "move", delta: event.key === "ArrowUp" ? -1 : 1 })
        }
      },
      options,
    )
    document.addEventListener(
      "focusout",
      (event) => {
        if (state.editing && event.target === state.editing.element) finishEditing(true)
      },
      options,
    )
    document.addEventListener("pointerdown", onPointerDown, options)
    document.addEventListener("pointermove", onPointerMove, options)
    document.addEventListener("pointerup", onPointerUp, options)
    document.addEventListener("pointercancel", onPointerUp, options)
    window.addEventListener("scroll", schedule, options)
    window.addEventListener("resize", schedule, options)

    // A re-render can replace the selected element; find its successor, or let the selection go.
    state.observer = new MutationObserver(() => {
      const selected = state.selected

      if (selected && !selected.isConnected) {
        const next = find(pathOf(selected), fingerprintOf(selected))
        state.selected = next
        post({ type: "omai:visual:select", element: next ? infoOf(next) : null })
      }
      if (state.hovered && !state.hovered.isConnected) state.hovered = undefined
      schedule()
    })
    state.observer.observe(document.body, { childList: true, subtree: true, characterData: true })
    post({ type: "omai:visual:ready", ...palette() })
  }

  const disable = () => {
    if (!state.enabled) return
    finishEditing(true)
    state.enabled = false
    state.abort?.abort()
    state.observer?.disconnect()
    if (state.frame !== undefined) cancelAnimationFrame(state.frame)
    state.host?.remove()
    Object.assign(state, {
      selected: undefined,
      hovered: undefined,
      drag: undefined,
      resize: undefined,
      abort: undefined,
      observer: undefined,
      frame: undefined,
      host: undefined,
      ui: undefined,
    })
  }

  const isChange = (value: unknown): value is Change => {
    if (!value || typeof value !== "object") return false
    const change = value as Change

    return text(change.path, 2048) && !!change.fingerprint && typeof change.fingerprint.tag === "string"
      && ["style", "text", "attribute", "move"].includes(change.kind) && text(change.after, 65536) && text(change.before, 65536)
  }

  function command(input: Record<string, unknown>) {
    const name = input.name

    if (name === "enable") return enable(input.labels)
    if (name === "disable") return disable()
    if (!state.enabled) return
    if (name === "apply" && Array.isArray(input.changes))
      return input.changes.filter(isChange).forEach((change) => applyChange(change, change.after, change.html))
    if (name === "revert" && isChange(input.change)) return revertChange(input.change)
    if (name === "select" && text(input.path, 2048)) {
      const element = (() => {
        try {
          return document.querySelector(input.path) ?? undefined
        } catch {
          return undefined
        }
      })()
      return select(element)
    }
    const selected = state.selected

    if (!selected) return
    if (name === "parent" && selected.parentElement && selected.parentElement !== document.body) return select(selected.parentElement)
    if (name === "style" && text(input.property, 64) && /^[a-z-]+$/.test(input.property) && text(input.value, 2048)) {
      const before = getComputedStyle(selected).getPropertyValue(input.property)
      setStyle(selected, input.property, input.value)
      return report(selected, { kind: "style", property: input.property, before, after: input.value })
    }
    if (name === "text" && text(input.value, 65536) && plainText(selected)) {
      const before = clean(selected.textContent)
      setText(selected, input.value)
      return report(selected, { kind: "text", before, after: input.value })
    }
    if (name === "attribute" && text(input.attr, 16) && EDITABLE_ATTRS.includes(input.attr) && text(input.value, 8 * 1024 * 1024)) {
      const before = selected.getAttribute(input.attr) ?? ""
      setAttr(selected, input.attr, input.value)
      return report(selected, { kind: "attribute", property: input.attr, before, after: input.value })
    }
    if (name === "move" && (input.delta === -1 || input.delta === 1)) {
      const before = siblingIndex(selected)
      const count = selected.parentElement?.children.length ?? 1
      const after = Math.min(count, Math.max(1, before + input.delta))

      if (after === before) return
      moveTo(selected, after)
      report(selected, { kind: "move", before: String(before), after: String(after) })
    }
  }

  window.addEventListener("message", (event) => {
    if (event.origin !== parentOrigin || event.source !== window.parent) return
    const data = event.data

    if (!data || data.type !== "omai:visual:command" || data.v !== 1 || !data.command || typeof data.command !== "object") return
    try {
      command(data.command)
    } catch (error) {
      post({ type: "omai:visual:error", message: error instanceof Error ? error.message : "The edit failed." })
    }
  })
  // The bridge loads this script asynchronously; the window enables it once it says it is here.
  post({ type: "omai:visual:loaded" })
}
