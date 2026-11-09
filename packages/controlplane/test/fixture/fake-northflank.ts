// An in-memory Northflank API v1 for tests: services, volumes and ports of one or more projects, with switches for the
// API's traps (a new service hidden for a while, rate limits, racing creates) and a log of every request.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"

export type FakeService = {
  id: string
  project: string
  name: string
  description?: string
  instances: number
  paused: boolean
  image?: string
  env: Record<string, string>
  ports: { name: string; internalPort: number; public: boolean; protocol: string; dns?: string }[]
  plan?: string
  volumes: string[]
  /** Requests naming this service that still answer 404, as right after a create. */
  hiddenFor: number
}
export type FakeVolume = { id: string; project: string; name: string; size: number; mount: string; attachedTo?: string }

export async function fakeNorthflank() {
  const state = {
    services: new Map<string, FakeService>(),
    volumes: new Map<string, FakeVolume>(),
    requests: [] as { method: string; path: string; body?: unknown; auth?: string }[],
    /** The next N requests answer 429 with this Retry-After (seconds). */
    limited: { count: 0, retryAfter: "0" },
    /** New services stay hidden for this many requests naming them. */
    hideNew: 0,
    /** The next service create answers 409 after creating the service, as a racing create would. */
    raceNextCreate: false,
    pageSize: 100,
  }
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    const text = Buffer.concat(chunks).toString()
    const body = text ? JSON.parse(text) : undefined
    const url = new URL(req.url ?? "/", "http://nf")
    state.requests.push({ method: req.method ?? "", path: url.pathname, body, auth: req.headers.authorization })
    handle(req, res, url, body)
  })

  function json(res: ServerResponse, status: number, value?: unknown) {
    res.writeHead(status, { "content-type": "application/json" })
    res.end(value === undefined ? "" : JSON.stringify(value))
  }
  const fail = (res: ServerResponse, status: number, message: string) =>
    json(res, status, { error: { status, message } })

  function page<A>(res: ServerResponse, url: URL, items: A[], wrap: (items: A[]) => unknown) {
    const start = Number(url.searchParams.get("cursor") ?? 0)
    const size = Math.min(state.pageSize, Number(url.searchParams.get("per_page") ?? 50))
    const slice = items.slice(start, start + size)
    const next = start + size < items.length
    json(res, 200, {
      data: wrap(slice),
      pagination: { hasNextPage: next, count: slice.length, ...(next ? { cursor: String(start + size) } : {}) },
    })
  }

  function handle(req: IncomingMessage, res: ServerResponse, url: URL, body: any) {
    if (state.limited.count > 0) {
      state.limited.count--
      res.writeHead(429, { "retry-after": state.limited.retryAfter, "content-type": "application/json" })
      return res.end(JSON.stringify({ error: { status: 429, message: "Too many requests" } }))
    }
    const match = /^\/v1\/projects\/([^/]+)(\/.*)$/.exec(url.pathname)
    if (!match) return fail(res, 404, "Not found")
    const project = match[1]!
    const route = match[2]!
    const key = `${req.method} ${route}`
    const services = [...state.services.values()].filter((item) => item.project === project)
    const volumes = [...state.volumes.values()].filter((item) => item.project === project)

    if (key === "GET /services")
      return page(res, url, services, (items) => ({
        services: items.map((item) => ({ id: item.id, name: item.name, description: item.description })),
      }))
    if (key === "POST /services/deployment") {
      if (services.some((item) => item.name === body.name)) return fail(res, 409, "A service with this name exists")
      const service: FakeService = {
        id: body.name,
        project,
        name: body.name,
        description: body.description,
        instances: body.deployment.instances,
        paused: false,
        image: body.deployment.external?.imagePath,
        env: body.runtimeEnvironment ?? {},
        ports: (body.ports ?? []).map((port: FakeService["ports"][number]) => ({
          ...port,
          ...(port.public ? { dns: `${port.name}--${body.name}--abcd.code.run` } : {}),
        })),
        plan: body.billing?.deploymentPlan,
        volumes: [],
        hiddenFor: state.hideNew,
      }
      state.services.set(service.id, service)
      if (state.raceNextCreate) {
        state.raceNextCreate = false
        return fail(res, 409, "A service with this name exists")
      }
      return json(res, 200, { data: { id: service.id, name: service.name } })
    }
    const named = /^\/services\/(?:deployment\/)?([^/]+)(\/.*)?$/.exec(route)
    if (named) {
      const service = state.services.get(named[1]!)
      if (!service || service.project !== project) return fail(res, 404, "Could not find service")
      if (service.hiddenFor > 0) {
        service.hiddenFor--
        return fail(res, 404, "Could not find service")
      }
      const rest = named[2] ?? ""
      if (req.method === "GET" && rest === "")
        return json(res, 200, {
          data: {
            id: service.id,
            name: service.name,
            servicePaused: service.paused,
            deployment: { instances: service.instances },
          },
        })
      if (req.method === "PATCH" && route.startsWith("/services/deployment/")) {
        if (service.paused) return fail(res, 409, "Service is paused")
        if (body.deployment?.instances !== undefined) service.instances = body.deployment.instances
        return json(res, 200, { data: {} })
      }
      if (req.method === "POST" && rest === "/pause") {
        if (service.paused) return fail(res, 409, "Service is already paused")
        service.paused = true
        return json(res, 200, { data: {} })
      }
      if (req.method === "POST" && rest === "/resume") {
        if (!service.paused) return fail(res, 409, "Service is not paused")
        service.paused = false
        return json(res, 200, { data: {} })
      }
      if (req.method === "POST" && rest === "/runtime-environment") {
        service.env = body.runtimeEnvironment
        return json(res, 200, { data: {} })
      }
      if (req.method === "GET" && rest === "/ports") return json(res, 200, { data: { ports: service.ports } })
    }
    if (key === "GET /volumes") return page(res, url, volumes, (items) => items.map((item) => ({ id: item.id, name: item.name })))
    if (key === "POST /volumes") {
      if (volumes.some((item) => item.name === body.name)) return fail(res, 409, "A volume with this name exists")
      const volume: FakeVolume = {
        id: body.name,
        project,
        name: body.name,
        size: body.spec.storageSize,
        mount: body.mounts[0].containerMountPath,
      }
      state.volumes.set(volume.id, volume)
      return json(res, 200, { data: { id: volume.id } })
    }
    const attach = /^\/volumes\/([^/]+)\/attach$/.exec(route)
    if (attach && req.method === "POST") {
      const volume = state.volumes.get(attach[1]!)
      if (!volume) return fail(res, 404, "Could not find volume")
      const service = state.services.get(body.nfObject.id)
      if (!service || service.hiddenFor > 0) {
        if (service) service.hiddenFor--
        return fail(res, 404, "Could not find service")
      }
      if (volume.attachedTo) return fail(res, 409, "Volume already attached")
      volume.attachedTo = service.id
      service.volumes.push(volume.id)
      return json(res, 200, { data: {} })
    }
    return fail(res, 404, `No route ${key}`)
  }

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  return {
    state,
    apiBase: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
    reset() {
      state.services.clear()
      state.volumes.clear()
      state.requests = []
      state.limited = { count: 0, retryAfter: "0" }
      state.hideNew = 0
      state.raceNextCreate = false
      state.pageSize = 100
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}
