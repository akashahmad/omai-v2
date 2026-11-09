const EVENTS = ["pointermove", "pointerdown", "keydown", "wheel", "touchstart", "focus"] as const

const EVERY_MS = 30_000

// The control plane pauses a VM after 2 minutes without activity; presence stops counting at the same point.
const RECENT_MS = 120_000

/**
 * Tells the control plane, every 30 s, that the open project is in use: only while its tab is visible and the user
 * interacted in the last 2 minutes. Returns a dispose function.
 */
export function createPresence(input: {
  projectID: () => string | undefined
  send: (projectID: string) => void
  now?: () => number
  every?: (fn: () => void, ms: number) => () => void
  visible?: () => boolean
  /** Whether the user is in the preview's frame, whose own pointer and key events never reach this page. */
  framed?: () => boolean
}) {
  const now = input.now ?? (() => Date.now())
  const visible = input.visible ?? (() => document.visibilityState === "visible")
  const framed = input.framed ?? (() => document.hasFocus() && document.activeElement instanceof HTMLIFrameElement)

  const every =
    input.every ??
    ((fn: () => void, ms: number) => {
      const id = setInterval(fn, ms)

      return () => clearInterval(id)
    })

  const state = { last: -Infinity }

  const report = () => {
    const projectID = input.projectID()

    if (!projectID || !visible() || now() - state.last >= RECENT_MS) return
    input.send(projectID)
  }

  // Back after a quiet spell: say so at once, since the VM may be about to pause (or already paused).
  const onEvent = () => {
    const quiet = now() - state.last >= RECENT_MS
    state.last = now()

    if (quiet) report()
  }

  EVENTS.forEach((name) => window.addEventListener(name, onEvent, { passive: true }))

  const stop = every(() => {
    if (framed()) state.last = now()
    report()
  }, EVERY_MS)

  return () => {
    stop()
    EVENTS.forEach((name) => window.removeEventListener(name, onEvent))
  }
}

/** The project a connection's address belongs to (`<router>/vm/<projectID>`), if it is a project VM. */
export function projectOfConnection(url: string) {
  const match = /\/vm\/([^/]+)\/?$/.exec(new URL(url).pathname)

  return match ? decodeURIComponent(match[1]!) : undefined
}
