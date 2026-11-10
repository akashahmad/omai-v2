export * as NorthflankClient from "./northflank-client.js"

/** A refused or failed Northflank API call. The message is Northflank's own, never the request or its token. */
export class NorthflankError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = "NorthflankError"
  }
}

export type ServiceSummary = { id: string; name: string }
export type ServiceDetail = { id: string; name: string; servicePaused?: boolean; deployment?: { instances?: number } }
export type VolumeSummary = { id: string; name: string }
export type ServicePort = { name: string; internalPort: number; public?: boolean; dns?: string }
type Pagination = { hasNextPage: boolean; cursor?: string }
type ErrorBody = { error?: { message?: string }; message?: string }

const RATE_LIMIT_RETRIES = 3

export type Client = ReturnType<typeof make>

/**
 * Northflank API v1 for one project. The control plane creates, pauses and resumes; the only deletes are for unclaimed
 * reserve VMs, and the provider guards which names those may name.
 */
export function make(input: { apiBase: string; token: string; project: string }) {
  const base = `${input.apiBase.replace(/\/+$/, "")}/projects/${encodeURIComponent(input.project)}`

  const request = async <A>(method: string, path: string, body?: unknown, attempt = 0): Promise<A> => {
    const response = await fetch(base + path, {
      method,
      headers: {
        authorization: `Bearer ${input.token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
    })
    const text = await response.text()
    // The rate limit is shared by the whole team, so a burst elsewhere can refuse a call this process barely made. A
    // throttled request was never applied, so waiting and retrying is safe for every method.
    if (response.status === 429 && attempt < RATE_LIMIT_RETRIES) {
      await new Promise((resolve) => setTimeout(resolve, retryDelay(response.headers.get("retry-after"), attempt)))
      return request<A>(method, path, body, attempt + 1)
    }
    if (!response.ok) throw new NorthflankError(response.status, errorMessage(text, response.status))
    return (text ? JSON.parse(text) : undefined) as A
  }

  // Lists are cursor-paginated: reading only the first page made a service past it look missing to the old project,
  // and the create that followed clashed on its name.
  const all = async <A>(path: string, items: (data: unknown) => A[], cursor?: string): Promise<A[]> => {
    const body = await request<{ data: unknown; pagination?: Pagination }>(
      "GET",
      `${path}?per_page=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
    )
    const page = items(body.data)
    if (!body.pagination?.hasNextPage || !body.pagination.cursor) return page
    return [...page, ...(await all(path, items, body.pagination.cursor))]
  }

  return {
    listServices: () => all("/services", (data) => (data as { services: ServiceSummary[] }).services),
    createService: async (payload: unknown) =>
      (await request<{ data: { id: string } }>("POST", "/services/deployment", payload)).data,
    getService: async (id: string) =>
      (await request<{ data: ServiceDetail }>("GET", `/services/${encodeURIComponent(id)}`)).data,
    /** Replaces the service's runtime variables; Northflank restarts a running service with them. */
    setRuntimeEnvironment: (id: string, variables: Record<string, string>) =>
      request("POST", `/services/${encodeURIComponent(id)}/runtime-environment`, { runtimeEnvironment: variables }),
    scaleService: (id: string, instances: number) =>
      request("PATCH", `/services/deployment/${encodeURIComponent(id)}`, { deployment: { instances } }),
    describeService: (id: string, description: string) =>
      request("PATCH", `/services/deployment/${encodeURIComponent(id)}`, { description }),
    pauseService: (id: string) => request("POST", `/services/${encodeURIComponent(id)}/pause`, {}),
    resumeService: (id: string) => request("POST", `/services/${encodeURIComponent(id)}/resume`, {}),
    getPorts: async (id: string) =>
      (await request<{ data: { ports: ServicePort[] } }>("GET", `/services/${encodeURIComponent(id)}/ports`)).data
        .ports,
    listVolumes: () => all("/volumes", (data) => data as VolumeSummary[]),
    createVolume: async (payload: unknown) => (await request<{ data: { id: string } }>("POST", "/volumes", payload)).data,
    deleteService: (id: string) => request("DELETE", `/services/${encodeURIComponent(id)}`),
    deleteVolume: (id: string) => request("DELETE", `/volumes/${encodeURIComponent(id)}`),
    attachVolume: (volumeID: string, serviceID: string) =>
      request("POST", `/volumes/${encodeURIComponent(volumeID)}/attach`, { nfObject: { id: serviceID, type: "service" } }),
  }
}

/** `Retry-After` (seconds) when given, else 1 s, 2 s, 4 s; at most 10 s. */
function retryDelay(header: string | null, attempt: number) {
  const seconds = header === null ? Number.NaN : Number(header)
  return Math.min(Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : 1000 * 2 ** attempt, 10_000)
}

function errorMessage(text: string, status: number) {
  const body = (() => {
    try {
      return JSON.parse(text) as ErrorBody
    } catch {
      return undefined
    }
  })()
  return body?.error?.message ?? body?.message ?? (text.slice(0, 200) || `Northflank API error (${status})`)
}
