// The script the proxy adds to every page of the preview. A cross-origin frame can't be read from outside, so the page
// reports its own location and errors to O M A I + and takes back, forward and reload from it. It also loads the
// visual editor (visual.ts) when the window asks.

/**
 * The bridge for pages entered from `parentOrigin`. It only ever posts to that origin and only obeys messages from it;
 * without one (the preview opened in its own tab) it reports nothing.
 */
export function bridgeScript(parentOrigin: string | undefined) {
  return `(() => {
  const parentOrigin = ${JSON.stringify(parentOrigin ?? null)}
  const post = (message) => {
    if (parentOrigin && window.parent && window.parent !== window) window.parent.postMessage(message, parentOrigin)
  }
  const report = () => post({ type: "omai:location", href: location.href, title: document.title })
  for (const name of ["pushState", "replaceState"]) {
    const original = history[name]
    history[name] = function (...args) {
      const result = original.apply(this, args)
      report()
      return result
    }
  }
  // The window tells a page of the preview from an error page that replaced it (a VM pausing, a lost connection) by
  // whether the next page reports itself after this one left.
  window.addEventListener("pagehide", () => post({ type: "omai:leave" }))
  window.addEventListener("popstate", report)
  window.addEventListener("hashchange", report)
  window.addEventListener("load", report)
  report()
  // The app's own pages, from the links on the page, for the address bar's list. Sent on load and again after the
  // page's links change, at most a few times a second.
  const pages = () => {
    const found = new Set([new URL(location.href).pathname])
    for (const link of document.querySelectorAll("a[href]")) {
      try {
        const url = new URL(link.getAttribute("href"), location.href)
        if (url.origin === new URL(location.href).origin && !url.pathname.startsWith("/__omai/")) found.add(url.pathname)
      } catch {}
    }
    post({ type: "omai:pages", pages: [...found].sort().slice(0, 200) })
  }
  let pending
  const schedule = () => {
    clearTimeout(pending)
    pending = setTimeout(pages, 300)
  }
  window.addEventListener("load", pages)
  try {
    new MutationObserver(schedule).observe(document.body || document.documentElement, { childList: true, subtree: true })
  } catch {}
  window.addEventListener("message", (event) => {
    if (!parentOrigin || event.origin !== parentOrigin || event.source !== window.parent) return
    const data = event.data
    // The visual editor loads on demand; it removes itself when the window turns editing off.
    if (data && data.type === "omai:visual" && data.action === "load") {
      if (document.querySelector("script[data-omai-visual]")) return
      const script = document.createElement("script")
      script.src = "/__omai/visual.js"
      script.dataset.omaiVisual = ""
      document.head.appendChild(script)
      return
    }
    if (!data || data.type !== "omai:navigate") return
    if (data.action === "back") history.back()
    if (data.action === "forward") history.forward()
    if (data.action === "reload") location.reload()
    if (data.action === "go" && typeof data.href === "string") location.href = data.href
  })
  const text = (value) => {
    if (value instanceof Error) return value.stack || value.message
    if (typeof value === "string") return value
    try { return JSON.stringify(value) } catch { return String(value) }
  }
  const error = console.error
  console.error = (...args) => {
    post({ type: "omai:console", level: "error", message: args.map(text).join(" ") })
    return error.apply(console, args)
  }
  window.addEventListener("error", (event) => post({ type: "omai:console", level: "error", message: text(event.error || event.message) }))
  window.addEventListener("unhandledrejection", (event) => post({ type: "omai:console", level: "error", message: text(event.reason) }))
  try {
    new EventSource("/__omai/events").addEventListener("reload", () => location.reload())
  } catch {}
})()
`
}
