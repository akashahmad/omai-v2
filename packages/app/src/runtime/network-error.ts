import { ClientError } from "@opencode/client/promise"

// How browsers word a request that never got an answer: Chromium, Firefox and Safari.
const NETWORK_MESSAGES = [/^Failed to fetch$/, /^NetworkError when attempting to fetch resource/, /^Load failed$/]

/**
 * Whether `error` is a request that failed in transit (a dropped connection, a load balancer cutting it off, a VM that
 * paused), rather than a bug or an answer from the server. Such an error passes on its own once the network is back.
 */
export function isNetworkError(error: unknown): boolean {
  if (error instanceof ClientError && error.reason === "Transport") return true

  if (error instanceof TypeError && NETWORK_MESSAGES.some((pattern) => pattern.test(error.message))) return true

  return error instanceof Error && error.cause !== undefined && isNetworkError(error.cause)
}
