import type { ServerConnection } from "@/runtime/server/registry"

/**
 * Gets a project connection a fresh VM token and stores it on the connection; undefined when the address is not a
 * project the user can open now.
 */
export type ProjectTokenRefresh = (url: string, signal?: AbortSignal) => Promise<ServerConnection.HttpBase | undefined>

type Registry = { refresh?: ProjectTokenRefresh; wanted?: (url: string) => boolean; last: Map<string, number> }

// Module state, because server connections are created by the global server runtime, outside the control plane
// session that can open projects. The signed-in session registers itself here; signing out removes it.
const state: Registry = { last: new Map() }

// A flaky network must not turn into a stream of project opens.
const EVERY_MS = 60_000

/**
 * `wanted` says which connections may get a fresh token now. A fresh token opens the project, which starts its VM, and
 * the app keeps a connection to every project it opened: after a new sign-in all of them are turned away at once, and
 * only the one on screen should start. Reading the route in `wanted` lets a caller's effect ask again on navigation.
 */
export function setProjectTokenRefresh(refresh: ProjectTokenRefresh, wanted: (url: string) => boolean) {
  state.refresh = refresh
  state.wanted = wanted
  state.last.clear()

  return () => {
    if (state.refresh !== refresh) return
    state.refresh = undefined
    state.wanted = undefined
  }
}

/**
 * A VM token names the sign-in it was issued for, and the router turns it away once that sign-in ends, even while
 * the user is signed in again (another tab, or the session idled out while the laptop slept). Asks the control plane
 * for a fresh token, as reloading the page would, at most once a minute per project. Undefined when nothing changed.
 */
export async function refreshProjectToken(url: string, signal?: AbortSignal) {
  const refresh = state.refresh
  const last = state.last.get(url) ?? -Infinity

  // Not wanted now is no attempt: it is asked again, unthrottled, once the user is on that project.
  if (!refresh || !state.wanted?.(url) || Date.now() - last < EVERY_MS) return undefined
  state.last.set(url, Date.now())

  return refresh(url, signal).catch(() => undefined)
}

/** A project's event stream reconnect: a fresh token when the last one may have stopped working, else the current. */
export function projectReconnect(current: () => ServerConnection.HttpBase) {
  return async (signal: AbortSignal) => (await refreshProjectToken(current().url, signal)) ?? current()
}
