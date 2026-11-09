const EVENTS = ["pointermove", "pointerdown", "keydown", "wheel", "touchstart", "focus"] as const

const ACTIVE_EVERY_MS = 60_000

// Other tabs only need to hear about activity now and then; pointer moves fire constantly.
const BROADCAST_EVERY_MS = 5_000

/**
 * Logs the user out after `timeoutMs` without interaction in any of their tabs. Tabs share activity over a
 * BroadcastChannel. `onActive` (the session ping) runs at most once a minute.
 */
export function createIdleLogout(input: {
  timeoutMs: number
  onIdle: () => void
  onActive: () => void
  channel?: BroadcastChannel
  now?: () => number
  schedule?: (fn: () => void, ms: number) => () => void
}) {
  const now = input.now ?? (() => Date.now())

  const schedule =
    input.schedule ??
    ((fn: () => void, ms: number) => {
      const id = setTimeout(fn, ms)

      return () => clearTimeout(id)
    })

  const state = { cancel: () => {}, idle: false, lastActive: -Infinity, lastBroadcast: -Infinity }

  const arm = () => {
    state.cancel()
    state.cancel = schedule(() => {
      if (state.idle) return
      state.idle = true
      input.onIdle()
    }, input.timeoutMs)
  }

  const active = (local: boolean) => {
    if (state.idle) return
    arm()

    if (now() - state.lastActive >= ACTIVE_EVERY_MS) {
      state.lastActive = now()
      input.onActive()
    }

    if (!local || now() - state.lastBroadcast < BROADCAST_EVERY_MS) return
    state.lastBroadcast = now()
    input.channel?.postMessage({ type: "active" })
  }

  const onEvent = () => active(true)

  const onVisibility = () => {
    if (document.visibilityState === "visible") active(true)
  }

  const onMessage = (event: MessageEvent) => {
    if (event.data?.type === "active") active(false)
  }

  EVENTS.forEach((name) => window.addEventListener(name, onEvent, { passive: true }))
  document.addEventListener("visibilitychange", onVisibility)
  input.channel?.addEventListener("message", onMessage)
  arm()

  return () => {
    state.cancel()
    EVENTS.forEach((name) => window.removeEventListener(name, onEvent))
    document.removeEventListener("visibilitychange", onVisibility)
    input.channel?.removeEventListener("message", onMessage)
    input.channel?.close()
  }
}
