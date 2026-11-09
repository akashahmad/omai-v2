export * as PreviewOrigin from "./origin.js"

import type { PublishRemote } from "../publish/remote.js"

/**
 * On a project's VM, the preview's public origin from the control plane (Northflank publishes the preview port under
 * its own address). The control plane learns it only once the VM was created, so this asks every `interval` until it
 * is known, then stops.
 */
export function poll(
  target: PublishRemote.Target,
  options: { interval?: number; onKnown?: (origin: string) => void } = {},
) {
  const state: { value?: string; closed: boolean; timer?: ReturnType<typeof setTimeout> } = { closed: false }
  const ask = async () => {
    const answer = await fetch(`${target.url}/internal/projects/${encodeURIComponent(target.projectID)}/vm`, {
      headers: { authorization: `Bearer ${target.token}` },
      signal: AbortSignal.timeout(10_000),
    })
      .then((response) => (response.ok ? (response.json() as Promise<{ preview?: unknown }>) : undefined))
      .catch(() => undefined)
    if (state.closed) return
    if (typeof answer?.preview === "string") {
      state.value = answer.preview
      options.onKnown?.(answer.preview)
      return
    }
    state.timer = setTimeout(ask, options.interval ?? 5_000)
  }
  void ask()
  return {
    get: () => state.value,
    close() {
      state.closed = true
      clearTimeout(state.timer)
    },
  }
}
