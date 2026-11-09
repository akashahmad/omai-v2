import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import type { Config } from "../../src/publish/config.js"

/** An in-memory stand-in for the Cloudflare endpoints the publish client uses. */
export async function fakeCloudflare() {
  const state = {
    zones: new Set(["omai.test"]),
    scripts: new Map<string, string[]>(),
    kv: new Map<string, string>(),
    /** DNS records by name; the value is the record type. */
    records: new Map<string, string>(),
    namespaces: new Set(["ns"]),
    kvNamespaces: new Map([["omai-hostnames", "kv-1"]]),
    /** Account-level Workers, such as the dispatcher. */
    workers: new Set<string>(),
    routes: [] as { id: string; pattern: string; script?: string }[],
    fallbackOrigin: undefined as string | undefined,
    /** When set, the fallback origin GET answers 200 with this as its `result`, whatever `fallbackOrigin` holds. */
    fallbackOriginResult: undefined as unknown,
    hostnames: new Map<
      string,
      {
        id: string
        hostname: string
        status: string
        ssl: { status: string }
        ownership_verification?: { name: string; type: string; value: string }
      }
    >(),
    /** When set, every request fails with this status and message (the body also carries a secret-looking field). */
    failing: undefined as { status: number; code: number; message?: string } | undefined,
    /** When true, KV writes fail with a 500. */
    failingKv: false,
    /** Answered before the exact match by every custom hostname read, as a loose list filter would. */
    similarHostnames: [] as { id: string; hostname: string; status: string; ssl: { status: string } }[],
    /** Custom hostname reads for these hosts fail with a 500. */
    failingHostnames: new Set<string>(),
    /** When true, requests are never answered. */
    hanging: false,
    requests: [] as {
      method: string
      path: string
      auth: string | undefined
    }[],
  }
  const ok = (result: unknown, info?: unknown) => ({
    status: 200,
    body: JSON.stringify({ success: true, errors: [], result, ...(info ? { result_info: info } : {}) }),
  })
  /** One page of `items`, honouring `per_page` and `page` like Cloudflare's list endpoints. */
  const paged = (url: URL, items: unknown[]) => {
    const size = Number(url.searchParams.get("per_page") ?? 20)
    const page = Number(url.searchParams.get("page") ?? 1)
    return ok(items.slice((page - 1) * size, page * size), {
      page,
      per_page: size,
      total_pages: Math.ceil(items.length / size),
    })
  }
  const fail = (status: number, code: number, message?: string) => ({
    status,
    body: JSON.stringify({
      success: false,
      errors: [{ code, message }],
      result: null,
      secret: "raw-body-detail",
    }),
  })

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://fake")
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    const body = Buffer.concat(chunks).toString()
    state.requests.push({
      method: req.method ?? "",
      path: url.pathname,
      auth: req.headers.authorization,
    })
    if (state.hanging) return
    const reply = state.failing
      ? fail(state.failing.status, state.failing.code, state.failing.message)
      : route(req.method ?? "", url, body)
    res.writeHead(reply.status, { "Content-Type": "application/json" })
    res.end(reply.body)
  })

  const route = (method: string, url: URL, body: string) => {
    const parts = url.pathname.split("/").filter(Boolean)
    if (parts[0] === "zones" && parts.length === 1)
      return ok(state.zones.has(url.searchParams.get("name") ?? "") ? [{ id: "zone-1" }] : [])
    if (parts[0] === "zones" && parts[2] === "dns_records") {
      if (method === "POST") {
        const record = JSON.parse(body) as { type: string; name: string }
        const zone = [...state.zones][0]
        state.records.set(record.name === "*" ? `*.${zone}` : record.name, record.type)
        return ok({ id: `rec-${state.requests.length}` })
      }
      const name = url.searchParams.get("name")
      if (name !== null) return ok(state.records.has(name) ? [{ id: "rec-1" }] : [])
      return paged(
        url,
        [...state.records].map(([recordName, type], i) => ({ id: `rec-${i}`, type, name: recordName })),
      )
    }
    if (parts[0] === "zones" && parts[2] === "workers" && parts[3] === "routes") {
      if (method === "GET") return ok(state.routes.map((r) => ({ ...r, script: r.script ?? null })))
      const route = JSON.parse(body) as { pattern: string; script?: string }
      if (state.routes.some((r) => r.pattern === route.pattern)) return fail(409, 10020, "duplicate route")
      const created = { id: `route-${state.requests.length}`, ...route }
      state.routes.push(created)
      return ok(created)
    }
    if (parts[0] === "zones" && parts[2] === "custom_hostnames" && parts[3] === "fallback_origin") {
      if (method === "PUT") {
        state.fallbackOrigin = (JSON.parse(body) as { origin: string }).origin
        return ok({ origin: state.fallbackOrigin, status: "pending_deployment" })
      }
      if (state.fallbackOriginResult !== undefined) return ok(state.fallbackOriginResult)
      return state.fallbackOrigin
        ? ok({ origin: state.fallbackOrigin, status: "active" })
        : fail(404, 1551, "fallback origin not found")
    }
    if (parts[0] === "zones" && parts[2] === "custom_hostnames") {
      if (method === "POST") {
        const host = (JSON.parse(body) as { hostname: string }).hostname
        // The request count only grows, so ids stay unique after deletes.
        const created = {
          id: `ch-${state.requests.length}`,
          hostname: host,
          status: "pending",
          ssl: { status: "initializing" },
          ownership_verification: {
            name: `_cf-custom-hostname.${host}`,
            type: "txt",
            value: "token-1",
          },
        }
        state.hostnames.set(host, created)
        return ok(created)
      }
      if (method === "GET") {
        if (state.failingHostnames.has(url.searchParams.get("hostname") ?? "")) return fail(500, 1000, "Internal error")
        const found = state.hostnames.get(url.searchParams.get("hostname") ?? "")
        return ok([...state.similarHostnames, ...(found ? [found] : [])])
      }
      const id = parts[3] ?? ""
      const entry = [...state.hostnames.entries()].find(([, h]) => h.id === id)
      if (!entry) return fail(404, 1551, "Custom hostname not found")
      state.hostnames.delete(entry[0])
      return ok({ id })
    }
    if (parts[0] === "accounts" && parts[2] === "storage") {
      if (parts.length === 5 && method === "POST") {
        const title = (JSON.parse(body) as { title: string }).title
        state.kvNamespaces.set(title, `kv-${state.requests.length}`)
        return ok({ id: state.kvNamespaces.get(title), title })
      }
      if (parts.length === 5) return paged(url, [...state.kvNamespaces].map(([title, id]) => ({ id, title })))
      const key = decodeURIComponent(parts[7] ?? "")
      if (method === "PUT" && state.failingKv) return fail(500, 10001, "KV write failed")
      if (method === "PUT") return (state.kv.set(key, body), ok({}))
      const value = state.kv.get(key)
      if (value === undefined) return fail(404, 10009, "key not found")
      if (method === "DELETE") return (state.kv.delete(key), ok({}))
      return { status: 200, body: value }
    }
    if (parts[0] === "accounts" && parts[2] === "workers" && parts[3] === "scripts")
      return state.workers.has(parts[4] ?? "") ? ok({ logpush: false }) : fail(404, 10007, "script not found")
    if (parts[0] === "accounts" && parts[2] === "workers" && parts[3] === "dispatch" && parts.length <= 6) {
      if (method === "POST") {
        const name = (JSON.parse(body) as { name: string }).name
        state.namespaces.add(name)
        return ok({ namespace_id: `ns-${name}`, namespace_name: name })
      }
      return state.namespaces.has(parts[5] ?? "")
        ? ok({ namespace_name: parts[5] })
        : fail(404, 100119, "dispatch namespace not found")
    }
    if (parts[0] === "accounts" && parts[2] === "workers" && parts[3] === "dispatch") {
      const name = parts[7] ?? ""
      if (parts[8] === "tags") {
        if (method === "PUT") return (state.scripts.set(name, JSON.parse(body) as string[]), ok([]))
        const tags = state.scripts.get(name)
        return tags ? ok(tags) : fail(404, 10007, "script not found")
      }
      if (method === "PUT") return (state.scripts.set(name, state.scripts.get(name) ?? []), ok({ id: name }))
      if (method === "DELETE") return state.scripts.delete(name) ? ok({}) : fail(404, 10007, "script not found")
      // Cloudflare answers 200 with `script: null` for a missing script.
      return ok({ script: state.scripts.has(name) ? { id: name } : null })
    }
    return fail(404, 7003, "no route")
  }

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const config: Config = {
    accountID: "acct",
    token: "secret-token",
    zone: "omai.test",
    namespace: "ns",
    apexIPs: [],
    api: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
  }
  return {
    state,
    config,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}
