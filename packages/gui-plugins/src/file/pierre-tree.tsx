import "@pierre/trees/web-components"
import { FileTree, type FileTreeDirectoryHandle, type FileTreeItemHandle } from "@pierre/trees"
import { getIcon } from "@opencode/ui/icons/catalog"
import { createMemo, createRoot, createSignal, getOwner, onCleanup, onMount, type JSX } from "solid-js"
import type { ChangeKind } from "@opencode/plugin/gui/review"
import { createKeyed, usePlugin, type FileNode, type MountedSession, type SessionScreen } from "@opencode/plugin/gui"
import { startFileDrag } from "./drag"
import { OpenInAppContextMenuV2, useOpenInApp } from "./open-in-app"
import { resolveOpenInAppPath } from "./path"
import {
  buildAllowedTreeInput,
  buildGitStatusMap,
  buildLiveTreeInput,
  diffGitStatusPatch,
  FILE_TREE_ROW_HEIGHT,
  normalizeFileTreeV2Path,
  type AllowedTreeInput,
  type TreeGitStatus,
} from "./tree-model"

const TREE_UNSAFE_CSS = `
  :host {
    color-scheme: inherit;
    --trees-font-family: var(--font-family-sans); --trees-font-size: 12px;
    --trees-fg: var(--v2-text-text-muted); --trees-fg-muted: var(--v2-text-text-muted);
    --trees-bg: var(--v2-background-bg-base); --trees-bg-muted: var(--v2-overlay-simple-overlay-hover);
    --trees-border-color: color-mix(in srgb, var(--v2-border-border-muted) 50%, transparent);
    --trees-indent-guide-bg: color-mix(in srgb, var(--v2-border-border-muted) 50%, transparent);
    --trees-selected-bg: var(--v2-overlay-simple-overlay-pressed); --trees-selected-fg: var(--v2-text-text-base);
    --trees-selected-focused-border-color: transparent; --trees-focus-ring-color: transparent; --trees-focus-ring-width: 0px;
    --trees-git-modified-color: var(--v2-state-fg-info); --trees-git-renamed-color: var(--v2-state-fg-info);
    --trees-git-added-color: var(--v2-state-fg-success); --trees-git-untracked-color: var(--v2-state-fg-success);
    --trees-git-deleted-color: var(--v2-state-fg-danger); --trees-git-ignored-color: var(--v2-text-text-faint);
    --trees-padding-inline: 8px; --trees-item-margin-x: 0px;
  }
  [data-file-tree-virtualized-root="true"] { padding-block-start: 4px; }
  /* The patched scroll limit counts this padding and the horizontal scrollbar, so neither fights the wheel. */
  [data-file-tree-virtualized-scroll="true"] { padding-block: 0 8px; padding-inline: 8px; overflow-x: auto; }
  /* Long rows scroll sideways rather than clip; every row is as wide as the widest one seen in this row set. */
  [data-file-tree-virtualized-list="true"] { width: max-content; min-width: max(100%, var(--file-tree-min-width, 0px)); }
  [data-item-section="spacing"] {
    padding-left: 0;
    padding-inline-start: calc(var(--trees-icon-width) / 2 - 0.5px);
  }
  [data-item-section="spacing-item"] {
    border-left: none; margin-right: 0;
    border-inline-start: 1px solid var(--trees-indent-guide-bg);
    margin-inline-end: calc(var(--trees-level-gap) - 1px);
    transform: none;
  }
  [data-item-section="spacing-item"] + [data-item-section="spacing-item"] {
    margin-left: 0;
    margin-inline-start: calc(var(--trees-item-row-gap) + var(--trees-icon-width) / 2 - 0.5px);
  }
  [data-type="item"][aria-expanded="false"] [data-item-section="icon"] > svg:first-child {
    transform: translateY(var(--trees-icon-nudge));
  }
  [data-type="item"][aria-expanded="true"] [data-item-section="icon"] > svg:first-child {
    transform: translateY(var(--trees-icon-nudge)) rotate(90deg);
  }
  :host(:dir(rtl)) [data-type="item"][aria-expanded="false"] [data-item-section="icon"] > svg:first-child {
    transform: translateY(var(--trees-icon-nudge)) rotate(180deg);
  }
  button[data-type="item"] {
    --row-overlay: transparent;
    box-shadow: none !important; cursor: inherit; font-weight: 500;
  }
  button[data-type="item"]:hover, button[data-type="item"][data-item-context-hover="true"] {
    --row-overlay: var(--v2-overlay-simple-overlay-hover);
    background-color: var(--row-overlay) !important;
  }
  button[data-type="item"][data-item-selected="true"], button[data-type="item"][data-item-selected="true"]:hover {
    --row-overlay: var(--v2-overlay-simple-overlay-pressed);
    color: var(--v2-text-text-base) !important; background-color: var(--row-overlay) !important;
  }
  button[data-type="item"]:focus-visible, button[data-type="item"][data-item-focused="true"] {
    outline: none !important; box-shadow: none !important;
  }
  button[data-type="item"]::before,
  [data-item-section="decoration"]:empty { display: none !important; }
  /* A folder holding changes keeps its lane, so the row still ends in the sticky end, but shows no dot. */
  [data-item-contains-git-change="true"]:not([data-item-git-status]) > [data-item-section="git"] > * { visibility: hidden; }
  [data-type="item"]:not([data-item-selected="true"]) > [data-item-section="icon"] > * { color: var(--v2-icon-icon-muted) !important; }
  [data-item-git-status]:not([data-item-git-status="ignored"]) > [data-item-section="content"] { color: inherit; }
  [data-item-section="content"] { flex: 1 0 auto; max-width: none; overflow: visible; white-space: nowrap; }
  [data-item-section="decoration"] { flex: 0 0 auto; color: var(--v2-text-text-weak, var(--v2-text-text-muted)); font-size: 12px; font-weight: 400; }
  [data-item-section="git"] {
    font-size: 11px; font-weight: 530; line-height: 1; letter-spacing: -0.04px;
    font-variant-numeric: tabular-nums lining-nums; font-feature-settings: "tnum" on, "lnum" on;
  }
  /* Every row ends in its change letter or an empty lane that sticks inside the pane while long rows scroll. It fades
     the name out over 16px and redraws the row's rounded end, so a row that runs past the pane looks like one that
     fits. */
  [data-item-section="git"] {
    position: sticky; inset-inline-end: var(--trees-item-padding-x);
    z-index: 1; align-self: stretch;
  }
  [data-item-section="git"]::before, [data-item-section="git"]::after {
    content: ""; position: absolute; inset-block: 0; z-index: -1; pointer-events: none;
  }
  /* The pane from the lane to the scroller's 8px edge, under the rounded end's corners. It stays within the row, as rows
     touch and a taller cover would paint over their neighbours. */
  [data-item-section="git"]::before {
    inset-inline: 0 calc(-1 * (var(--trees-item-padding-x) + 8px));
    background: var(--trees-bg);
  }
  /* The row from the 16px fade over the name through its rounded end. */
  [data-item-section="git"]::after {
    inset-inline: -16px calc(-1 * var(--trees-item-padding-x));
    border-start-end-radius: var(--trees-border-radius); border-end-end-radius: var(--trees-border-radius);
    background:
      linear-gradient(to right, transparent, var(--row-overlay) 16px),
      linear-gradient(to right, transparent, var(--trees-bg) 16px);
  }
  :host(:dir(rtl)) [data-item-section="git"]::after {
    background:
      linear-gradient(to left, transparent, var(--row-overlay) 16px),
      linear-gradient(to left, transparent, var(--trees-bg) 16px);
  }
`

// The row menu's size, for keeping it inside the tree.
const MENU_WIDTH = 184

const MENU_HEIGHT = 196

function sameStringMap(a: ReadonlyMap<string, string> | undefined, b: ReadonlyMap<string, string> | undefined) {
  if (a === b) return true
  const sizeA = a?.size ?? 0
  const sizeB = b?.size ?? 0

  if (sizeA !== sizeB) return false

  if (sizeA === 0) return true

  for (const [key, value] of a ?? []) {
    if (b?.get(key) !== value) return false
  }

  return true
}

function isDirectoryHandle(handle: FileTreeItemHandle | null | undefined): handle is FileTreeDirectoryHandle {
  return Boolean(handle?.isDirectory())
}

function findTreeItemButton(event: Event) {
  for (const target of event.composedPath()) {
    if (target instanceof HTMLElement && target.dataset.type === "item" && target.dataset.itemPath) return target
  }
}

function findFileButtonPath(event: Event) {
  const button = findTreeItemButton(event)

  return button?.dataset.itemType === "file" ? button.dataset.itemPath : undefined
}

/** A row the tree's "⋯" menu acts on. `path` is the workspace path as the tree lists it, without a trailing slash. */
export type TreeMenuItem = { readonly kind: "file" | "directory"; readonly path: string; readonly name: string }

/** Row actions: a "⋯" button and a right-click menu on every row, and inline renaming. */
export type TreeMenu = {
  /** The menu's content. `rename` closes the menu and starts inline renaming of the row. */
  render(item: TreeMenuItem, actions: { close(): void; rename(): void }): JSX.Element
  /** Renames on the server and resolves false when that failed, which moves the row back. */
  rename(from: string, to: string): Promise<boolean>
}

export default function PierreFileTree(props: {
  session: MountedSession
  screen: SessionScreen
  active?: string
  allowed?: readonly string[]
  kinds?: ReadonlyMap<string, ChangeKind>
  labels?: ReadonlyMap<string, string>
  draggable?: boolean
  onFileClick?: (file: FileNode) => void
  onFileDoubleClick?: (file: FileNode) => void
  menu?: TreeMenu
}) {
  const ctx = usePlugin()
  const owner = getOwner()
  let disposeMenu: (() => void) | undefined
  let shiftedAnchor: HTMLElement | undefined
  const file = props.screen.file
  const openIn = ctx.desktop ? useOpenInApp({ session: props.session, path: () => file.root }) : undefined
  const live = () => props.allowed === undefined
  const draggable = () => props.draggable ?? true
  const active = () => normalizeFileTreeV2Path(props.active ?? "")
  const expanded = (path: string) => file.tree.state(path)?.expanded ?? false

  const allowedPaths = createMemo(() => (live() ? undefined : (props.allowed ?? [])), undefined, {
    equals: (previous, next) =>
      previous === next ||
      (previous !== undefined &&
        next !== undefined &&
        previous.length === next.length &&
        previous.every((item, index) => item === next[index])),
  })

  const allowedModel = createMemo(() => {
    const paths = allowedPaths()

    return paths ? buildAllowedTreeInput(paths) : undefined
  })

  const liveModel = createMemo(() =>
    live() ? buildLiveTreeInput((path) => file.tree.list(path), expanded) : undefined,
  )

  const [ready, setReady] = createSignal(false)
  const knownPaths = new Set<string>()
  const scrolled = { active: "" }
  let wrapper: HTMLDivElement | undefined
  let tree: FileTree | undefined
  let syncingSelection = false
  let syncingExpansion = false
  let appliedStatus = new Map<string, TreeGitStatus>()
  let renderedAllowed: AllowedTreeInput | undefined
  let renderedLabels: ReadonlyMap<string, string> | undefined
  let renderedKinds: ReadonlyMap<string, ChangeKind> | undefined
  let renderedIgnored: ReadonlySet<string> | undefined
  let renderedRoot = file.root
  let widthHost: HTMLElement | undefined
  let widest = 0

  // A new row set measures from the pane's width again.
  const resetWidth = () => {
    widest = 0
    widthHost?.style.removeProperty("--file-tree-min-width")
  }

  const originalPath = (rawPath: string) => {
    const norm = normalizeFileTreeV2Path(rawPath)

    return (live() ? liveModel()?.nodesByPath.get(norm)?.path : allowedModel()?.originalByPath.get(norm)) ?? norm
  }

  const syncSelection = (target: string) => {
    if (!tree || syncingSelection) return
    const item = target ? tree.getItem(target) : null
    const resolved = item && !item.isDirectory() ? target : ""
    const current = tree.getSelectedPaths()

    if (resolved ? current.length === 1 && current[0] === resolved : current.length === 0) return
    syncingSelection = true

    for (const existing of current) {
      if (existing !== resolved) tree.getItem(existing)?.deselect()
    }

    if (resolved) tree.getItem(resolved)?.select()
    syncingSelection = false
  }

  const applyAllowedCollapsed = (model: AllowedTreeInput) => {
    if (!tree) return
    syncingExpansion = true

    for (const dir of model.directories) {
      const expand = model.untrackedDirs.has(dir)
        ? file.tree.state(dir)?.expanded === true
        : file.tree.state(dir)?.expanded !== false

      if (expand) continue
      const handle = tree.getItem(dir)

      if (isDirectoryHandle(handle) && handle.isExpanded()) handle.collapse()
    }

    syncingExpansion = false
  }

  const toFileNode = (rawPath: string): FileNode => {
    const norm = normalizeFileTreeV2Path(rawPath)
    const existing = live() ? liveModel()?.nodesByPath.get(norm) : undefined

    if (existing) return existing
    const original = allowedModel()?.originalByPath.get(norm) ?? norm

    return { name: norm.split("/").at(-1) || norm, path: original, absolute: original, type: "file", ignored: false }
  }

  // Places the menu inside the tree, which clips what overflows it. A right-click pins the library's anchor with
  // `position: fixed` at the pointer, but an ancestor of the side panel is its containing block, so the anchor first
  // shifts back by what it missed. Returns the menu's offset from the anchor and whether it opens upwards.
  const placeMenu = (element: HTMLElement, rect: { top: number; left: number }) => {
    const anchor = element.closest<HTMLElement>('[data-type="context-menu-anchor"]')
    const bounds = tree?.getFileTreeContainer()?.getBoundingClientRect()

    if (!anchor || !bounds) return { left: 0, above: false }
    anchor.style.translate = ""
    const pointer = anchor.style.position === "fixed"

    if (pointer) {
      const missed = anchor.getBoundingClientRect()

      shiftedAnchor = anchor

      anchor.style.translate = `${rect.left - missed.left}px ${rect.top - missed.top}px`
    }

    const at = anchor.getBoundingClientRect()
    const wanted = pointer ? at.left : at.right - MENU_WIDTH
    const left = Math.min(Math.max(wanted, bounds.left + 4), bounds.right - MENU_WIDTH - 4)

    return { left: left - at.left, above: at.bottom + MENU_HEIGHT > bounds.bottom && at.top - MENU_HEIGHT > bounds.top }
  }

  const closeMenuRoot = () => {
    disposeMenu?.()
    disposeMenu = undefined

    // The anchor goes back to following the hovered row's "⋯" button.
    if (shiftedAnchor) shiftedAnchor.style.translate = ""
    shiftedAnchor = undefined
  }

  onCleanup(closeMenuRoot)

  // The menu renders under this component's owner, so it reads the plugin's context like any other view here.
  const menuOptions = (menu: TreeMenu) => ({
    composition: {
      contextMenu: {
        // Desktop keeps right-click for "Open in"; the web opens this menu on right-click too.
        triggerMode: openIn?.canOpen() ? ("button" as const) : ("both" as const),
        buttonVisibility: "when-needed" as const,
        render: (item: { kind: "file" | "directory"; path: string; name: string }, context: {
            anchorElement: HTMLElement
            anchorRect: { top: number; left: number }
            close(options?: { restoreFocus?: boolean }): void
          },
        ) => {
          closeMenuRoot()
          const place = placeMenu(context.anchorElement, context.anchorRect)
          const path = originalPath(item.path)
          const target: TreeMenuItem = { kind: item.kind, path: normalizeFileTreeV2Path(path), name: item.name }

          return createRoot((dispose) => {
            disposeMenu = dispose

            const element = (
              // Positioned from the anchor, out of the list's flow, so the menu never widens the scrolling list.
              <div
                data-file-tree-context-menu-root="true"
                class="absolute z-50"
                classList={{ "top-full mt-0.5": !place.above, "bottom-full mb-0.5": place.above }}
                style={{ left: `${place.left}px`, width: `${MENU_WIDTH}px` }}
              >
                {menu.render(target, {
                  close: () => context.close(),
                  rename: () => {
                    context.close({ restoreFocus: false })
                    tree?.startRenaming(item.path)
                  },
                })}
              </div>
            )

            return element instanceof HTMLElement ? element : null
          }, owner ?? undefined)
        },
        onClose: closeMenuRoot,
      },
    },
    renaming: {
      onRename: (event: { sourcePath: string; destinationPath: string; isFolder: boolean }) => {
        const from = normalizeFileTreeV2Path(originalPath(event.sourcePath))
        const to = normalizeFileTreeV2Path(event.destinationPath)
        // The tree moves the row itself; keep the paths it knows in step so the next listing doesn't add it again.
        const moved = renameKnown(event.sourcePath, event.destinationPath, event.isFolder)
        void menu.rename(from, to).then((ok) => {
          if (ok || !tree) return
          renameKnown(event.destinationPath, event.sourcePath, event.isFolder)
          tree.move(moved.to, moved.from)
        })
      },
      onError: (error: string) => ctx.toast.show({ variant: "error", title: error }),
    },
  })

  const renameKnown = (source: string, destination: string, folder: boolean) => {
    const from = folder ? `${normalizeFileTreeV2Path(source)}/` : normalizeFileTreeV2Path(source)
    const to = folder ? `${normalizeFileTreeV2Path(destination)}/` : normalizeFileTreeV2Path(destination)

    for (const item of [...knownPaths]) {
      if (item !== from && !(folder && item.startsWith(from))) continue
      knownPaths.delete(item)
      knownPaths.add(to + item.slice(from.length))
    }

    return { from, to }
  }

  onMount(() => {
    if (!wrapper) return
    const isLive = live()
    const initialAllowed = allowedModel()
    const initialLive = liveModel()
    const initialPaths = isLive ? (initialLive?.paths ?? []) : (initialAllowed?.paths ?? [])
    const initialStatus = buildGitStatusMap(props.kinds, initialLive?.ignoredPaths)
    const initialGitStatus = Array.from(initialStatus, ([path, status]) => ({ path, status }))
    const initialActive = active()

    if (isLive) {
      for (const item of initialPaths) knownPaths.add(item)
    }

    appliedStatus = initialStatus
    renderedAllowed = initialAllowed
    renderedLabels = props.labels
    renderedKinds = props.kinds
    renderedIgnored = initialLive?.ignoredPaths
    renderedRoot = file.root

    const actions = props.menu ? menuOptions(props.menu) : undefined

    tree = new FileTree({
      paths: initialPaths,
      flattenEmptyDirectories: false,
      initialExpansion: isLive ? "closed" : "open",
      initialExpandedPaths: isLive ? initialLive?.expandedDirs : undefined,
      initialSelectedPaths: initialActive ? [initialActive] : undefined,
      sort: isLive
        ? (a, b) => {
            const map = liveModel()?.orderByPath

            return (
              (map?.get(normalizeFileTreeV2Path(a.path)) ?? 0) -
              (map?.get(normalizeFileTreeV2Path(b.path)) ?? 0)
            )
          }
        : "default",
      icons: {
        set: "complete",
        spriteSheet: `<svg data-icon-sprite aria-hidden="true" width="0" height="0" xmlns="http://www.w3.org/2000/svg"><symbol id="outline-chevron-right" viewBox="${getIcon("outline-chevron-right").viewBox}" fill="none">${getIcon("outline-chevron-right").body}</symbol></svg>`,
        remap: {
          "file-tree-icon-chevron": { name: "outline-chevron-right", width: 16, height: 16, viewBox: "0 0 16 16" },
        },
      },
      itemHeight: FILE_TREE_ROW_HEIGHT,
      middleTruncate: false,
      stickyFolders: false,
      gitStatus: initialGitStatus.length > 0 ? initialGitStatus : undefined,
      dragAndDrop: draggable() ? { canDrag: () => true, canDrop: () => false } : false,
      unsafeCSS: TREE_UNSAFE_CSS,
      composition: actions?.composition,
      renaming: actions?.renaming,
      renderRowDecoration: ({ row }) => {
        if (row.kind !== "directory") return null
        const label = props.labels?.get(normalizeFileTreeV2Path(row.path))

        return label ? { text: label } : null
      },
      onExpansionChange(change) {
        resetWidth()

        if (syncingExpansion) return
        const original = originalPath(change.path)

        if (change.expanded) file.tree.expand(original, live() ? undefined : { list: false })
        else file.tree.collapse(original)
      },
      onSelectionChange: () => syncSelection(active()),
    })

    if (!isLive && initialAllowed) applyAllowedCollapsed(initialAllowed)
    tree.render({ containerWrapper: wrapper })
    tree.getFileTreeContainer()?.classList.add("omai-pierre-file-tree")
    widthHost = tree.getFileTreeContainer()
    const list = widthHost?.shadowRoot?.querySelector<HTMLElement>("[data-file-tree-virtualized-list]")
    const scroller = list?.closest<HTMLElement>("[data-file-tree-virtualized-scroll]")

    // Only some rows render, so the list's own width follows the rows on screen. Rows wider than the pane widen the
    // tree, which keeps that width while they scroll out of view; otherwise the scroll position would snap back.
    if (list && scroller) {
      const widen = new ResizeObserver(() => {
        if (scroller.scrollWidth <= scroller.clientWidth) return
        const width = list.getBoundingClientRect().width

        if (width <= widest) return
        widest = width
        widthHost?.style.setProperty("--file-tree-min-width", `${width}px`)
      })

      widen.observe(list)
      onCleanup(() => widen.disconnect())
    }

    setReady(true)
    onCleanup(() => {
      tree?.cleanUp()
      tree = undefined
    })
  })

  // The live tree lists the root whenever it is not loaded, e.g. again after the workspace's tree resets.
  createKeyed(
    () => {
      if (!live()) return
      const root = file.tree.state("")

      return root?.loaded ? undefined : { root }
    },
    () => void file.tree.sync(""),
  )

  // Replaces the tree paths when `allowed` changes after mount.
  createKeyed(
    () => (ready() && !live() ? allowedModel() : undefined),
    (model) => {
      if (!tree || model === renderedAllowed) return
      renderedAllowed = model
      syncSelection("")
      resetWidth()
      tree.resetPaths(model.paths)
      applyAllowedCollapsed(model)
      syncSelection(active())
    },
  )

  // Re-renders visible row decorations when untracked-folder labels change without resetting paths.
  createKeyed(
    () => (ready() && !live() ? { labels: props.labels } : undefined),
    (current) => {
      if (!tree || !wrapper || sameStringMap(renderedLabels, current.labels)) return
      renderedLabels = current.labels
      tree.render({ containerWrapper: wrapper })
    },
    { equals: (previous, next) => previous !== undefined && next !== undefined && sameStringMap(previous.labels, next.labels) },
  )

  // Incrementally batches newly loaded or unlinked directory entries into the live tree.
  createKeyed(
    () => (ready() && live() ? { root: file.root, model: liveModel()! } : undefined),
    (current) => {
      if (!tree) return

      if (current.root !== renderedRoot) {
        renderedRoot = current.root
        knownPaths.clear()
        tree.resetPaths([])
      }

      const nextSet = new Set(current.model.paths)
      const expandedSet = new Set(current.model.expandedDirs)
      const ops: Array<{ type: "add"; path: string } | { type: "remove"; path: string; recursive: boolean }> = []

      for (const existing of knownPaths) {
        if (nextSet.has(existing)) continue
        const trimmed = existing.endsWith("/") ? existing.slice(0, -1) : existing
        const slash = trimmed.lastIndexOf("/")
        const parent = slash === -1 ? "" : `${trimmed.slice(0, slash + 1)}`

        if (parent === "" || expandedSet.has(parent)) {
          ops.push({ type: "remove", path: existing, recursive: existing.endsWith("/") })
          knownPaths.delete(existing)
        }
      }

      for (const item of current.model.paths) {
        if (knownPaths.has(item)) continue
        knownPaths.add(item)
        ops.push({ type: "add", path: item })
      }

      if (ops.length > 0) {
        resetWidth()
        tree.batch(ops)
      }

      syncingExpansion = true

      for (const dir of current.model.expandedDirs) {
        const handle = tree.getItem(dir)

        if (isDirectoryHandle(handle) && !handle.isExpanded()) handle.expand()
      }

      syncingExpansion = false
      syncSelection(active())
    },
    { equals: (previous, next) => previous?.root === next?.root && previous?.model === next?.model },
  )

  // Incrementally patches git status badges and ignored entries via `applyGitStatusPatch`.
  createKeyed(
    () => (ready() ? { kinds: props.kinds, ignored: liveModel()?.ignoredPaths } : undefined),
    (current) => {
      if (!tree || (sameStringMap(current.kinds, renderedKinds) && current.ignored === renderedIgnored)) return
      renderedKinds = current.kinds
      renderedIgnored = current.ignored
      const next = buildGitStatusMap(current.kinds, current.ignored)
      const patch = diffGitStatusPatch(appliedStatus, next)
      appliedStatus = next

      if (patch.remove.length > 0 || patch.set.length > 0) tree.applyGitStatusPatch(patch)
    },
    {
      equals: (previous, next) =>
        previous !== undefined &&
        next !== undefined &&
        sameStringMap(previous.kinds, next.kinds) &&
        previous.ignored === next.ignored,
    },
  )

  // Only scroll when the active path changes (or first appears in the tree) and is outside the viewport.
  createKeyed(
    () => {
      if (!ready()) return { path: "", present: false }
      const path = active()
      void allowedModel()
      void liveModel()
      const item = path ? tree?.getItem(path) : null

      return { path, present: Boolean(item && !item.isDirectory()) }
    },
    (current) => {
      syncSelection(current.path)

      if (!current.path) {
        scrolled.active = ""

        return
      }

      if (!current.present || scrolled.active === current.path) return
      scrolled.active = current.path
      queueMicrotask(() => {
        if (!tree) return

        const scroller = tree
          .getFileTreeContainer()
          ?.shadowRoot?.querySelector<HTMLElement>("[data-file-tree-virtualized-scroll]")

        const scrollTop = scroller?.scrollTop ?? 0
        const viewportHeight = scroller?.clientHeight || 600
        const startIndex = Math.floor(scrollTop / FILE_TREE_ROW_HEIGHT)
        const endIndex = Math.max(startIndex, Math.floor((scrollTop + viewportHeight - 1) / FILE_TREE_ROW_HEIGHT))

        if (tree.getVisibleRows(startIndex, endIndex).some((row) => row.path === current.path)) return
        tree.scrollToPath(current.path, { focus: false, offset: "nearest" })
      })
    },
    { equals: (previous, next) => previous.path === next.path && previous.present === next.present },
  )

  const resolveContextPath = (event: MouseEvent) => {
    const rawPath = findFileButtonPath(event)

    if (!rawPath) return
    const node = toFileNode(rawPath)

    return resolveOpenInAppPath(file.root, node.absolute || node.path)
  }

  return (
    <OpenInAppContextMenuV2 state={openIn} resolvePath={resolveContextPath} fit>
      <div
        ref={wrapper}
        data-component="file-tree-v2"
        data-total-rows={live() ? (liveModel()?.paths.length ?? 0) : (allowedModel()?.total ?? 0)}
        class="group/file-tree-v2"
        on:keydown={{
          capture: true,
          handleEvent(event: KeyboardEvent) {
            if (!tree || !wrapper?.matches(":dir(rtl)")) return

            if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return

            if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
            event.preventDefault()
            event.stopPropagation()
            const focused = tree.getFocusedItem()

            if (!focused) {
              tree.focusFirstItem()

              return
            }

            const dir = isDirectoryHandle(focused) ? focused : undefined

            if (event.key === "ArrowLeft") {
              if (!dir) return

              if (!dir.isExpanded()) dir.expand()
              else tree.focusNextItem()

              return
            }

            if (dir?.isExpanded()) dir.collapse()
            else tree.focusParentItem()
          },
        }}
        onClick={(event) => {
          const path = findFileButtonPath(event)

          if (path) props.onFileClick?.(toFileNode(path))
        }}
        onDblClick={(event) => {
          const path = findFileButtonPath(event)

          if (path) props.onFileDoubleClick?.(toFileNode(path))
        }}
        onDragStart={(event) => {
          if (!draggable()) return
          const button = findTreeItemButton(event)

          if (button?.dataset.itemPath) startFileDrag(event, originalPath(button.dataset.itemPath))
        }}
      />
    </OpenInAppContextMenuV2>
  )
}
