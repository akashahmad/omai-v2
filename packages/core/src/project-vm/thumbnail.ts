export * as ProjectVmThumbnail from "./thumbnail.js"

export type Target = { url: string; projectID: string; token: string }

/** Where a project's MicroVM sends its preview screenshots; undefined anywhere else. */
export function target(env: Record<string, string | undefined> = process.env): Target | undefined {
  if (!env.OMAI_CONTROL_PLANE_URL || !env.OMAI_PROJECT_ID || !env.OMAI_PROJECT_TOKEN) return undefined
  return { url: env.OMAI_CONTROL_PLANE_URL, projectID: env.OMAI_PROJECT_ID, token: env.OMAI_PROJECT_TOKEN }
}

/**
 * Sends the latest screenshot to the control plane, which keeps it for the projects page even while this VM is
 * paused. A failure is reported as false and never thrown: the next capture sends again.
 */
export async function push(target: Target, data: Uint8Array) {
  const url = `${target.url.replace(/\/+$/, "")}/internal/projects/${encodeURIComponent(target.projectID)}/thumbnail`
  return fetch(url, {
    method: "POST",
    headers: { authorization: `Bearer ${target.token}`, "content-type": "image/webp" },
    body: Buffer.from(data),
    signal: AbortSignal.timeout(15_000),
  }).then(
    (res) => res.ok,
    () => false,
  )
}
