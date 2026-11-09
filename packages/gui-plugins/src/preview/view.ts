// One project's preview as the window sees it: the status and log from the server, and what the toolbar and the frame
// share, like the device, the zoom and the page on screen. The toolbar and the panel render apart, so both read one
// view per session.

import { createMemo, createRoot, createSignal, onCleanup, type Accessor, type Owner } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { createKeyed, type MountedSession } from "@opencode/plugin/gui"
import { Preview } from "@opencode/schema/preview"
import { appendLog, enterURL, locationFrom, pagesFrom, previewOrigin } from "./model"
import { visualMessage, type ElementInfo } from "./visual/protocol"
import { createVisual } from "./visual/session"

export type Device = "desktop" | "tablet" | "mobile"

/** The width each device renders at, before the zoom. */
export const DEVICE_WIDTH: Record<Device, number> = { desktop: 1440, tablet: 768, mobile: 360 }

export const ZOOM_OPTIONS = [25, 50, 75, 100, 125, 150, 200] as const

const WATCH_INTERVAL = 60_000

type State = {
  status: Preview.Status
  log: string
  path: string
  pages: string[]
  src?: string
  device: Device
  zoom: number
  logs: boolean
}

export type PreviewView = ReturnType<typeof createView>

/** Creates a session's view once and returns it on every later call, so the toolbar and the panel share it. */
/** What the views need from the plugin around them, for visual editing: the composer, dialogs and copy. */
export type ViewHooks = {
  /** Attaches the element to the session's composer, for a change described in words. */
  ask: (session: MountedSession, element: ElementInfo) => void
  /** Opens the replace-image dialog for the element. */
  image: (view: PreviewView, element: ElementInfo) => void
  /** The in-page mini-toolbar's tooltips, in the app's language. */
  labels: () => Record<string, string>
}

export function previewViews(owner: Owner | null, hooks: ViewHooks) {
  const views = new Map<string, PreviewView>()

  return (session: Accessor<MountedSession>) => {
    const key = session().key
    const existing = views.get(key)

    if (existing) return existing
    const created = createRoot(() => createView(session, hooks), owner)
    views.set(key, created)

    return created
  }
}

function createView(session: Accessor<MountedSession>, hooks: ViewHooks) {
  const [state, setState] = createStore<State>({
    status: { state: "idle" },
    log: "",
    path: "/",
    pages: ["/"],
    device: "desktop",
    zoom: 100,
    logs: false,
  })

  const [frame, setFrame] = createSignal<HTMLIFrameElement>()
  // How many renders have the preview on screen; the first one starts an idle preview.
  let watchers = 0

  const rpc = () => session().server.client.rpc(Preview.Definition)
  const scope = () => ({ location: { directory: session().directory } })
  const mine = (directory: string | undefined) => !directory || directory === session().directory
  const origin = createMemo(() => previewOrigin(session().server.url, state.status))

  const call = <T>(request: Promise<T>) =>
    request.then(
      (value) => value,
      () => undefined,
    )

  const apply = (status: Preview.Status | undefined) => {
    if (status) setState("status", reconcile(status))
  }

  const start = (input: { candidate?: number; retry?: boolean } = {}) =>
    void call(rpc().start({ sessionID: session().id, ...input }, scope())).then(apply)

  // The status and log, then every change, again whenever the server reconnects or another project is routed.
  createKeyed(
    () => (session().server.connected ? `${session().server.id}\u0000${session().directory}` : undefined),
    () => {
      const controller = new AbortController()
      const signal = controller.signal
      onCleanup(() => controller.abort())
      onCleanup(
        rpc().events.on(
          "changed",
          (event) => {
            if (mine(event.data.directory)) setState("status", reconcile(event.data))
          },
          { signal },
        ),
      )
      onCleanup(
        rpc().events.on(
          "log",
          (event) => {
            if (mine(event.data.directory)) setState("log", (log) => appendLog(log, event.data.chunk))
          },
          { signal },
        ),
      )
      void call(rpc().logs({}, { ...scope(), signal })).then((logs) => logs && setState("log", logs.text))
      void call(rpc().status({}, { ...scope(), signal })).then((status) => {
        if (!status || signal.aborted) return
        setState("status", reconcile(status))

        if (status.state === "idle" && watchers > 0) start()
      })
    },
  )

  // A VM learns its preview's public address a few seconds after the preview runs. The change arrives as an event, but
  // an event stream can drop it, so the status is also asked for until the address is there.
  createKeyed(
    () =>
      state.status.state === "running" && !origin() && session().server.connected
        ? `${session().server.id}\u0000${session().directory}`
        : undefined,
    () => {
      const timer = setInterval(() => void call(rpc().status({}, scope())).then(apply), 3_000)
      onCleanup(() => clearInterval(timer))
    },
  )

  // The frame enters the preview once per preview origin; restarts reload it from inside.
  createKeyed(
    () => (state.status.state === "running" ? origin() : undefined),
    (current) => {
      if (state.src?.startsWith(current)) return
      const ticket = state.status.auth ? call(rpc().ticket({}, scope())).then((value) => value?.ticket) : undefined
      void Promise.resolve(ticket).then((value) =>
        setState("src", enterURL(current, { parent: window.location.origin, to: state.path, ticket: value })),
      )
    },
  )

  const onMessage = (event: MessageEvent) => {
    const current = origin()

    if (!current || event.source !== frame()?.contentWindow) return
    const location = locationFrom(event, current)

    if (location) {
      setState("path", location.path)
      visual.pageLoaded()
    }

    const pages = pagesFrom(event, current)

    if (pages) setState("pages", pages)
    const message = visualMessage(event, current, frame()?.contentWindow)

    if (message) visual.handle(message)
  }

  const agentBusy = () => session().server.data.session.status(session().id) === "running"

  const visual = createVisual({
    post: (message) => {
      const current = origin()

      if (current) frame()?.contentWindow?.postMessage(message, current)
    },
    running: () => state.status.state === "running",
    prompt: (text) => session().server.data.session.prompt({ sessionID: session().id, text }).then(() => undefined),
    agentBusy,
    interrupt: () => session().server.client.session.interrupt({ sessionID: session().id }).then(() => undefined),
    ask: (element) => hooks.ask(session(), element),
    image: (element) => hooks.image(view, element),
    page: () => state.path,
    labels: hooks.labels,
  })

  // A save is done once the agent went busy for it and is idle again; follow the agent while one is underway.
  createKeyed(
    () => (visual.saving() === "working" ? (agentBusy() ? "busy" : "idle") : undefined),
    (activity) => visual.agentChanged(activity === "busy"),
  )

  // Editing ends with the preview it edits.
  createKeyed(
    () => visual.enabled() && state.status.state !== "running",
    () => visual.exit(),
  )

  window.addEventListener("message", onMessage)
  onCleanup(() => window.removeEventListener("message", onMessage))

  const navigate = (action: "back" | "forward" | "reload" | "go", href?: string) => {
    const current = origin()

    if (current) frame()?.contentWindow?.postMessage({ type: "omai:navigate", action, href }, current)
  }

  const view = {
    visual,
    /** Saves an uploaded image into the app's public folder; resolves to its address on the site. */
    asset: (name: string, base64: string) => rpc().asset({ name, base64 }, scope()),
    state,
    origin,
    running: () => state.status.state === "running",
    busy: () => ["detecting", "installing", "starting", "fixing"].includes(state.status.state),
    setFrame: (element: HTMLIFrameElement | undefined) => setFrame(element),
    /** Marks the preview as on screen while the returned function isn't called; starts it the first time. */
    watch: () => {
      watchers++

      if (state.status.state === "idle" && session().server.connected) start()
      const beat = () => void call(rpc().watch({}, scope()))
      beat()
      const timer = setInterval(beat, WATCH_INTERVAL)

      return () => {
        watchers--
        clearInterval(timer)
      }
    },
    start,
    stop: () => void call(rpc().stop({}, scope())).then(apply),
    restart: () => void call(rpc().restart({}, scope())).then(apply),
    setRecipe: (recipe: Preview.Recipe | null) => void call(rpc().setRecipe({ recipe }, scope())).then(apply),
    reload: () => navigate("reload"),
    back: () => navigate("back"),
    forward: () => navigate("forward"),
    go: (path: string) => {
      const current = origin()

      if (current) navigate("go", new URL(path.startsWith("/") ? path : `/${path}`, current).href)
    },
    href: (path = state.path) => {
      const current = origin()

      return current ? new URL(path, current).href : undefined
    },
    setDevice: (device: Device) => setState("device", device),
    setZoom: (zoom: number) => setState("zoom", zoom),
    toggleLogs: () => setState("logs", (open) => !open),
  }

  return view
}
