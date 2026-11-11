type Entry = { method: string; url: string; at: number; slow: boolean; priority: number }

// Chromium allows six connections per origin. The event stream holds one for the life of the
// connection and health probes use their own fetch, so the app's API calls stay below that or
// a burst stalls probes and user actions inside the browser where nothing can observe it.
const requestQueueLimit = 4

// Endpoints that shell out to git or walk the filesystem take seconds on a large repository. They
// may hold at most this many slots, so a session mount's small reads never queue behind them.
const requestQueueSlowLimit = 2

const slowRequestPaths = ["/api/vcs", "/api/worktree"]

// A mount legitimately fires a dozen requests at once; only a request that has waited this long
// for a slot indicates the server is not keeping up.
const requestStallMs = 2_000

// A socket that dies while the device sleeps can leave fetch waiting for response headers until the
// OS gives up on TCP retransmits, which takes minutes. Bound that so a dead request frees its slot
// instead of wedging every later API call; the body may still stream for as long as it needs.
const requestHeadersTimeoutMs = 60_000

// Creating a worktree runs the project's setup script (dependency installs, fetches) before the
// server answers, so it needs a budget measured in minutes rather than seconds. Cutting it off
// kills the script midway and leaves a registered but half-initialised worktree behind.
const setupRequestHeadersTimeoutMs = 10 * 60_000

// A read that fails in transit is asked again after these waits: the connection dropped, a load balancer cut it
// (while a VM wakes or a network blips), or its body stopped halfway. Writes are never sent twice.
const retryDelaysMs = [500, 1_500, 3_000]

function isSlowRequest(pathname: string) {
  return slowRequestPaths.some((path) => pathname === path || pathname.startsWith(`${path}/`))
}

function isSetupRequest(method: string, pathname: string) {
  return method === "POST" && pathname === "/api/worktree"
}

export function createRequestQueue(input: {
  fetch: typeof globalThis.fetch
  limit?: number
  slowLimit?: number
  stallMs?: number
  headersTimeoutMs?: number
  setupHeadersTimeoutMs?: number
  retryDelays?: number[]
  log?: (message: string, data: Record<string, unknown>) => void
  now?: () => number
}) {
  const limit = input.limit ?? requestQueueLimit
  const slowLimit = input.slowLimit ?? requestQueueSlowLimit
  const stallMs = input.stallMs ?? requestStallMs
  const headersTimeoutMs = input.headersTimeoutMs ?? requestHeadersTimeoutMs
  const setupHeadersTimeoutMs = input.setupHeadersTimeoutMs ?? setupRequestHeadersTimeoutMs
  const retryDelays = input.retryDelays ?? retryDelaysMs
  // Call the browser fetch unbound; `input.fetch(...)` would make `this` the options object.
  const base = input.fetch
  const now = input.now ?? Date.now
  const log = input.log ?? ((message, data) => console.warn(`[server-request-queue] ${message}`, data))
  const inflight = new Set<Entry>()
  const waiting: Array<{ entry: Entry; start: () => void }> = []
  let warned = -Infinity
  let watcher: ReturnType<typeof setTimeout> | undefined

  const describe = (entry: Entry) => ({ method: entry.method, url: entry.url, ms: now() - entry.at })

  // Debug exports include the console, so list what the server is busy with while requests wait.
  const watch = () => {
    watcher = undefined
    const oldest = waiting[0]?.entry

    if (!oldest) return

    if (now() - oldest.at >= stallMs && now() - warned >= 10_000) {
      warned = now()
      log("server thrashing detected", {
        limit,
        inflight: [...inflight].map(describe),
        queued: waiting.map((item) => describe(item.entry)),
      })
    }

    watcher = setTimeout(watch, stallMs)
  }

  const canStart = (entry: Entry) => {
    if (inflight.size >= limit) return false

    if (!entry.slow) return true

    return [...inflight].filter((item) => item.slow).length < slowLimit
  }

  // FIFO within each priority tier, except a slow request waits its turn behind faster ones while the slow slots are full.
  const release = (entry: Entry) => {
    inflight.delete(entry)
    const index = waiting.findIndex((item) => canStart(item.entry))

    if (index === -1) return
    waiting.splice(index, 1)[0]?.start()
  }

  const acquire = (entry: Entry) => {
    // A free slot must start fetch before the caller's synchronous UI work.
    // Awaiting an already-resolved promise postpones that dispatch until after it.
    if (canStart(entry)) {
      inflight.add(entry)

      return
    }

    return new Promise<void>((resolve) => {
      const start = () => {
        entry.at = now()
        inflight.add(entry)
        resolve()
      }

      const position = waiting.findIndex((item) => item.entry.priority < entry.priority)
      waiting.splice(position === -1 ? waiting.length : position, 0, { entry, start })
      watcher ??= setTimeout(watch, stallMs)
    })
  }

  const once = async (resource: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(resource, init)
    const url = new URL(request.url)
    const pathname = url.pathname

    // The event stream is long-lived; never count it against the request budget.
    if (pathname === "/api/event") return base(request)
    // Writes go first. Session lists and the first transcript page unblock navigation, so they
    // go ahead of location reads. Older pages and filtered indexes keep background priority.
    const initialMessages =
      /^\/api\/session\/[^/]+\/message$/.test(pathname) &&
      !url.searchParams.has("cursor") &&
      !url.searchParams.has("before") &&
      !url.searchParams.has("type") &&
      url.searchParams.get("order") !== "asc"

    const priority = request.method !== "GET" ? 2 : pathname === "/api/session" || initialMessages ? 1 : 0
    const entry = { method: request.method, url: request.url, at: now(), slow: isSlowRequest(pathname), priority }

    const queued = acquire(entry)

    if (queued) await queued

    if (request.signal.aborted) {
      release(entry)
      throw request.signal.reason ?? new DOMException("The operation was aborted.", "AbortError")
    }

    const controller = new AbortController()
    request.signal.addEventListener("abort", () => controller.abort(request.signal.reason), { once: true })

    const timer = setTimeout(
      () => controller.abort(new DOMException("Timed out waiting for the server to respond", "TimeoutError")),
      isSetupRequest(request.method, pathname) ? setupHeadersTimeoutMs : headersTimeoutMs,
    )

    return base(new Request(request, { signal: controller.signal })).finally(() => {
      clearTimeout(timer)
      release(entry)
    })
  }

  // A read is safe to send again. Its JSON body is read here, so a body cut off halfway is retried like a failed
  // connection instead of failing whoever reads it; streams and files pass through as they arrive.
  const read = async (resource: RequestInfo | URL, init?: RequestInit) => {
    const response = await once(resource, init)

    if (!response.headers.get("content-type")?.includes("json")) return response

    // Browsers report a body that stopped as a TypeError, other runtimes otherwise; an abort stays an abort.
    const body = await response.arrayBuffer().catch((error: Error) => {
      if (error instanceof DOMException && (error.name === "AbortError" || error.name === "TimeoutError")) throw error
      throw new TypeError("The response stopped halfway", { cause: error })
    })

    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    })
  }

  const fetch: typeof globalThis.fetch = Object.assign(
    async (resource: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(resource, init)
      const method = request.method

      if ((method !== "GET" && method !== "HEAD") || new URL(request.url).pathname === "/api/event")
        return once(resource, init)

      for (const delay of retryDelays) {
        const result = await read(resource, init).then(
          (response) => ({ response }),
          (error: Error) => ({ error }),
        )

        if ("response" in result) return result.response

        // Only a failure in transit is worth another try: not an abort, a timeout or a caller's own error.
        if (request.signal.aborted || !(result.error instanceof TypeError)) throw result.error
        await new Promise((resolve) => setTimeout(resolve, delay))
      }

      return read(resource, init)
    },
    // Bun's fetch type carries preconnect; the browser never calls it.
    { preconnect: () => {} },
  )

  return {
    fetch,
    inflight: () => inflight.size,
    queued: () => waiting.length,
  }
}
