// One project's preview as the window sees it: the status and log from the server, and what the toolbar and the frame
// share, like the device, the zoom and the page on screen. The toolbar and the panel render apart, so both read one
// view per session.

import { createMemo, createRoot, createSignal, onCleanup, type Accessor, type Owner } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { createKeyed, type MountedSession } from "@opencode/plugin/gui"
import { Preview } from "@opencode/schema/preview"
import {
  aliveFrom,
  appendLog,
  enterURL,
  leftFrom,
  locationFrom,
  pagesFrom,
  previewHealth,
  previewOrigin,
} from "./model"
import { visualMessage, type ElementInfo } from "./visual/protocol"
import { createVisual } from "./visual/session"

export type Device = "desktop" | "tablet" | "mobile"

/** The width each device renders at, before the zoom. */
export const DEVICE_WIDTH: Record<Device, number> = { desktop: 1440, tablet: 768, mobile: 360 }

export const ZOOM_OPTIONS = [25, 50, 75, 100, 125, 150, 200] as const

const WATCH_INTERVAL = 60_000

/** How long a page in the frame has, after it loads, to report itself before the window asks the preview why. */
const REPORT_GRACE = 2_500

/** How long the window waits for the preview to answer before it loads the frame anyway. */
const REACH_LIMIT = 20_000

/** At most this many automatic reloads a minute; then the preview shows as unreachable. */
const RECOVER_LIMIT = 3

/** How long a page that has been beating may stay silent, in a visible tab, before the frame is entered again. */
const SILENCE_LIMIT = 8_000

/** How long after a page of the preview leaves the next one has to report itself before the frame is covered. */
const COVER_GRACE = 1_000

type State = {
  status: Preview.Status
  log: string
  path: string
  pages: string[]
  src?: string
  /** The preview didn't answer: the panel shows the brand icon, and reload restarts the preview. */
  unreachable: boolean
  /**
   * The frame may show a page that isn't the preview's (an error page after the VM paused or the connection dropped):
   * the panel covers it with the brand loader until a page of the preview reports itself.
   */
  covered: boolean
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
    unreachable: false,
    covered: false,
    device: "desktop",
    zoom: 100,
    logs: false,
  })

  const [frame, setFrame] = createSignal<HTMLIFrameElement>()
  // Bumped to enter the preview again in a fresh frame.
  const [entry, setEntry] = createSignal(0)
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
      // A frame on screen from before the connection dropped may hold a page the preview no longer accepts (the VM
      // paused and started again): it is entered again, with a fresh ticket.
      const shown = state.src !== undefined || state.unreachable
      void call(rpc().status({}, { ...scope(), signal })).then((status) => {
        if (!status || signal.aborted) return
        setState("status", reconcile(status))

        if (status.state === "idle" && watchers > 0) start()

        if (status.state === "running" && shown) setEntry((value) => value + 1)
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

  // Whether the page now in the frame reported itself, the automatic reloads of the last minute, when the page last
  // said anything, and whether its pages beat at all (older previews don't, and are never judged by silence).
  const frameState = {
    reported: false,
    recoveries: new Array<number>(),
    check: setTimeout(() => {}, 0),
    cover: setTimeout(() => {}, 0),
    heard: Date.now(),
    beats: false,
  }

  onCleanup(() => {
    clearTimeout(frameState.check)
    clearTimeout(frameState.cover)
  })

  // A page of the preview beats every 2 seconds. Silence means something else took its place, such as the browser's
  // own error page after a reload while the connection dropped, whatever order the events around it came in. A hidden
  // tab throttles the beat, so silence counts only while the tab is visible, from when it became visible.
  const silence = setInterval(() => {
    if (!frameState.beats || !state.src || state.status.state !== "running") return

    if (document.visibilityState !== "visible" || Date.now() - frameState.heard < SILENCE_LIMIT) return
    frameState.heard = Date.now()
    setState("covered", true)
    recover()
  }, 2_000)

  const visible = () => (frameState.heard = Date.now())

  document.addEventListener("visibilitychange", visible)
  onCleanup(() => {
    clearInterval(silence)
    document.removeEventListener("visibilitychange", visible)
  })

  // Each time the preview runs (and after a recovery), the frame enters it again, but only once the preview itself
  // answers: until a VM's port is up, the load balancer in front of it answers with an error page that would stay in the
  // frame. A preview that doesn't answer in time is shown as unreachable instead.
  createKeyed(
    () => (state.status.state === "running" && origin() ? `${origin()}\u0000${entry()}` : undefined),
    () => {
      const current = origin()!
      const controller = new AbortController()
      onCleanup(() => controller.abort())
      clearTimeout(frameState.cover)
      setState({ src: undefined, unreachable: false, covered: false })
      void enter(current, controller.signal)
    },
  )

  const enter = async (current: string, signal: AbortSignal) => {
    const reached = await reach(current, signal)

    if (signal.aborted) return

    if (!reached) return void setState("unreachable", true)
    const ticket = state.status.auth ? await call(rpc().ticket({}, scope())).then((value) => value?.ticket) : undefined

    if (signal.aborted) return
    frameState.reported = false
    frameState.heard = Date.now()
    setState("src", enterURL(current, { parent: window.location.origin, to: state.path, ticket }))
  }

  // Asks the preview until it answers, sooner when the browser comes back online; false after REACH_LIMIT.
  const reach = async (current: string, signal: AbortSignal) => {
    const deadline = Date.now() + REACH_LIMIT

    for (let wait = 500; !signal.aborted && Date.now() < deadline; wait = Math.min(wait * 2, 3_000)) {
      if (await previewHealth(current)) return true
      await pause(wait, signal)
    }

    return false
  }

  // A page that loads without reporting itself isn't the preview's: an error page from the network in between, after
  // the page reloaded while the VM paused or the connection dropped. The frame enters the preview again once it answers.
  const frameLoaded = () => {
    const current = origin()
    clearTimeout(frameState.check)

    if (!current || state.status.state !== "running") return
    frameState.check = setTimeout(() => {
      if (frameState.reported || origin() !== current || state.status.state !== "running") return
      setState("covered", true)
      recover()
    }, REPORT_GRACE)
  }

  // Enters the preview again in a fresh frame, once it answers.
  const recover = () => {
    const now = Date.now()
    frameState.recoveries = frameState.recoveries.filter((at) => now - at < 60_000)

    // Reloading keeps landing on a page that isn't the preview's: show it as unreachable, never that page.
    if (frameState.recoveries.length >= RECOVER_LIMIT) return void setState({ src: undefined, unreachable: true })
    frameState.recoveries.push(now)
    setEntry((value) => value + 1)
  }

  const onMessage = (event: MessageEvent) => {
    const current = origin()

    if (!current || event.source !== frame()?.contentWindow) return

    if (event.origin === current) frameState.heard = Date.now()

    if (aliveFrom(event, current)) frameState.beats = true

    if (leftFrom(event, current)) {
      frameState.reported = false
      // Another page of the preview usually reports itself at once (a reload, a link); anything else is covered.
      clearTimeout(frameState.cover)
      frameState.cover = setTimeout(() => {
        if (!frameState.reported) setState("covered", true)
      }, COVER_GRACE)
    }

    const location = locationFrom(event, current)

    if (location) {
      frameState.reported = true
      clearTimeout(frameState.cover)
      setState("covered", false)
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
    prompt: (text) =>
      session()
        .server.data.session.prompt({ sessionID: session().id, text })
        .then(() => undefined),
    agentBusy,
    interrupt: () =>
      session()
        .server.client.session.interrupt({ sessionID: session().id })
        .then(() => undefined),
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

  // Restarts the preview and enters it again in a fresh frame once it answers, whatever the frame showed before.
  const restart = () => {
    frameState.recoveries = []
    setState({ unreachable: false, covered: false })
    void call(rpc().restart({}, scope())).then((status) => {
      apply(status)
      setEntry((value) => value + 1)
    })
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
    /** The frame finished loading a page, the first or any later one. */
    frameLoaded,
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
    setRecipe: (recipe: Preview.Recipe | null) => void call(rpc().setRecipe({ recipe }, scope())).then(apply),
    restart,
    /** The same as Restart: whatever the frame shows, reload brings the preview back. */
    reload: restart,
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

/** Waits `ms`, or less when the browser comes back online or the wait is no longer wanted. */
function pause(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer)
      window.removeEventListener("online", done)
      signal.removeEventListener("abort", done)
      resolve()
    }

    const timer = setTimeout(done, ms)

    window.addEventListener("online", done)
    signal.addEventListener("abort", done)
  })
}
