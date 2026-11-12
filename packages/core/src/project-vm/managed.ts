export * as ProjectVmManaged from "./managed.js"

/**
 * The refresh token a project's VM holds for a sign-in. The real one stays on the control plane, which refreshes each
 * sign-in in one place: several VMs refreshing one sign-in themselves would rotate its refresh token out from under each
 * other. Matches `MANAGED_REFRESH` in the control plane.
 */
export const MANAGED_REFRESH = "omai-managed"

/** Asks the control plane for a sign-in with time left; undefined when it can't be had now. */
export type Refresher = (credential: {
  id: string
  integrationID: string
}) => Promise<{ access: string; expires: number } | undefined>

const state: { refresher?: Refresher } = {}

/** On a project's MicroVM: how its managed sign-ins are refreshed, for the rest of the process. */
export function register(refresher: Refresher | undefined) {
  state.refresher = refresher
}

export function refresher() {
  return state.refresher
}
