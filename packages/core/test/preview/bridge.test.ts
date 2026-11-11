import { describe, expect, test } from "bun:test"
import { bridgeScript } from "@opencode/core/preview/bridge"

const PARENT = "http://localhost:4096"

// Just enough of a browser page for the bridge: history, location, events, a parent frame and the console.
function page() {
  const posted: Array<{ message: unknown; origin: string }> = []
  const listeners = new Map<string, Array<(event: unknown) => void>>()
  const calls: string[] = []
  const location = { href: "http://127.0.0.1:5000/", reload: () => calls.push("reload") }
  const parent = { postMessage: (message: unknown, origin: string) => posted.push({ message, origin }) }
  const history = {
    pushState: (_: unknown, __: string, url: string) => {
      location.href = new URL(url, location.href).href
    },
    replaceState: (_: unknown, __: string, url: string) => {
      location.href = new URL(url, location.href).href
    },
    back: () => calls.push("back"),
    forward: () => calls.push("forward"),
  }
  const console = { error: (..._: unknown[]) => {} }
  const window = {
    parent,
    addEventListener: (name: string, listener: (event: unknown) => void) =>
      listeners.set(name, [...(listeners.get(name) ?? []), listener]),
  }
  class EventSource {
    addEventListener() {}
  }
  const links = ["/about", "pricing", "https://elsewhere.example/x", "/about#team", "/__omai/bridge.js", "#top"]
  const appended: Array<{ src: string; dataset: Record<string, string> }> = []
  const document = {
    title: "App",
    createElement: () => ({ src: "", dataset: {} as Record<string, string>, setAttribute() {} }),
    head: { appendChild: (node: { src: string; dataset: Record<string, string> }) => appended.push(node) },
    querySelector: (selector: string) =>
      selector === "script[data-omai-visual]" ? appended.find((node) => node.dataset.omaiVisual !== undefined) : null,
    querySelectorAll: () => links.map((href) => ({ getAttribute: () => href })),
    body: {},
  }
  class MutationObserver {
    observe() {}
  }
  const dispatch = (name: string, event: unknown) => listeners.get(name)?.forEach((listener) => listener(event))
  new Function(
    "window",
    "history",
    "location",
    "document",
    "console",
    "EventSource",
    "MutationObserver",
    bridgeScript(PARENT),
  )(window, history, location, document, console, EventSource, MutationObserver)
  return { posted, calls, history, console, parent, dispatch, appended }
}

describe("bridge", () => {
  test("reports the page's own links on load", () => {
    const view = page()
    view.dispatch("load", {})

    expect(view.posted.find((item) => (item.message as { type: string }).type === "omai:pages")).toEqual({
      message: { type: "omai:pages", pages: ["/", "/about", "/pricing"] },
      origin: PARENT,
    })
  })

  // The window can tell a page of the preview from an error page that replaced it only if each page says it is going.
  test("says when the page leaves", () => {
    const view = page()
    view.dispatch("pagehide", {})

    expect(view.posted.at(-1)).toEqual({ message: { type: "omai:leave" }, origin: PARENT })
  })

  test("reports the location after pushState", () => {
    const view = page()
    view.history.pushState({}, "", "/about")

    expect(view.posted.at(-1)).toEqual({
      message: { type: "omai:location", href: "http://127.0.0.1:5000/about", title: "App" },
      origin: PARENT,
    })
  })

  test("ignores navigation from another origin", () => {
    const view = page()
    view.dispatch("message", {
      origin: "https://evil.example",
      source: view.parent,
      data: { type: "omai:navigate", action: "back" },
    })

    expect(view.calls).toEqual([])
  })

  test("goes back when the parent asks", () => {
    const view = page()
    view.dispatch("message", { origin: PARENT, source: view.parent, data: { type: "omai:navigate", action: "back" } })

    expect(view.calls).toEqual(["back"])
  })

  test("forwards console errors", () => {
    const view = page()
    view.console.error("broke", 42)

    expect(view.posted.at(-1)).toEqual({
      message: { type: "omai:console", level: "error", message: "broke 42" },
      origin: PARENT,
    })
  })

  test("stays silent without a parent origin", () => {
    const posted: unknown[] = []
    new Function(
      "window",
      "history",
      "location",
      "document",
      "console",
      "EventSource",
      "MutationObserver",
      bridgeScript(undefined),
    )(
      { parent: { postMessage: (message: unknown) => posted.push(message) }, addEventListener: () => {} },
      { pushState: () => {}, replaceState: () => {} },
      { href: "http://127.0.0.1:5000/" },
      { title: "", querySelectorAll: () => [], body: {} },
      { error: () => {} },
      class {
        addEventListener() {}
      },
      class {
        observe() {}
      },
    )

    expect(posted).toEqual([])
  })

  test("loads the visual editor only when asked", () => {
    const view = page()
    expect(view.appended).toEqual([])

    view.dispatch("message", { origin: "https://evil.example", source: view.parent, data: { type: "omai:visual", action: "load" } })
    expect(view.appended).toEqual([])

    view.dispatch("message", { origin: PARENT, source: view.parent, data: { type: "omai:visual", action: "load" } })
    view.dispatch("message", { origin: PARENT, source: view.parent, data: { type: "omai:visual", action: "load" } })
    expect(view.appended).toHaveLength(1)
    expect(view.appended[0]?.src).toBe("/__omai/visual.js")
  })
})
