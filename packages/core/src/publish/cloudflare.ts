export * as Cloudflare from "./cloudflare.js"

import { Schema } from "effect"
import { KV_TITLE, type Config } from "./config.js"

const OWNER_TAG = "omai-project-"
const PLACEHOLDER = `export default { fetch: () => new Response("Deploying…", { status: 503 }) }`

export type Hostname = {
  id: string
  hostname: string
  status: string
  ssl: { status: string }
  ownership?: { name: string; value: string }
}

/** A non-2xx Cloudflare response. `message` is Cloudflare's first error message, never the raw body. */
export class CloudflareError extends Error {
  constructor(
    readonly status: number,
    readonly codes: number[],
    message: string,
  ) {
    super(message)
    this.name = "CloudflareError"
  }
}

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))
const decodeErrors = Schema.decodeUnknownOption(
  Schema.Struct({
    errors: Schema.Array(Schema.Struct({ code: Schema.Number, message: Schema.optional(Schema.String) })),
  }),
)
const decodeResult = Schema.decodeUnknownOption(Schema.Struct({ result: Schema.Unknown }))
const decodePage = Schema.decodeUnknownOption(
  Schema.Struct({
    result: Schema.Array(Schema.Unknown),
    result_info: Schema.optional(
      Schema.Struct({ total_pages: Schema.optional(Schema.Number), total_count: Schema.optional(Schema.Number) }),
    ),
  }),
)
const decodeRecords = Schema.decodeUnknownOption(
  Schema.Array(Schema.Struct({ type: Schema.String, name: Schema.String })),
)
const decodeRoutes = Schema.decodeUnknownOption(
  Schema.Array(
    Schema.Struct({ id: Schema.String, pattern: Schema.String, script: Schema.optional(Schema.NullOr(Schema.String)) }),
  ),
)
const decodeCreated = Schema.decodeUnknownOption(Schema.Struct({ id: Schema.String }))
const decodeOrigin = Schema.decodeUnknownOption(Schema.Struct({ origin: Schema.String }))
const decodeTags = Schema.decodeUnknownOption(Schema.Array(Schema.String))
const decodeIDs = Schema.decodeUnknownOption(Schema.Array(Schema.Struct({ id: Schema.String })))
const decodeKvList = Schema.decodeUnknownOption(
  Schema.Array(Schema.Struct({ id: Schema.String, title: Schema.String })),
)
const decodeScript = Schema.decodeUnknownOption(Schema.Struct({ script: Schema.Struct({}) }))
const decodeHostname = Schema.decodeUnknownOption(
  Schema.Struct({
    id: Schema.String,
    hostname: Schema.String,
    status: Schema.String,
    ssl: Schema.Struct({ status: Schema.String }),
    ownership_verification: Schema.optional(Schema.Struct({ name: Schema.String, value: Schema.String })),
  }),
)

export function hostnameStatus(h: Hostname): "pending" | "active" | "error" {
  const bad = ["blocked", "moved", "deleted"]
  if (bad.includes(h.status) || bad.includes(h.ssl.status) || h.ssl.status.startsWith("validation_timed_out"))
    return "error"
  if (h.status === "active" && h.ssl.status === "active") return "active"
  return "pending"
}

/** How long one Cloudflare request may take, body included. */
export const TIMEOUT = 30_000

/** `readOnly` makes every non-GET request throw before it is sent. */
export function client(config: Config, timeout = TIMEOUT, options: { readOnly?: boolean } = {}) {
  const account = `/accounts/${config.accountID}`
  const scripts = `${account}/workers/dispatch/namespaces/${config.namespace}/scripts`
  const memo = new Map<string, Promise<string>>()

  /** Memoises the first success per key; a failure is not cached. */
  const once = (key: string, load: () => Promise<string>) => {
    const cached = memo.get(key)
    if (cached) return cached
    const next = load()
    memo.set(key, next)
    next.catch(() => memo.delete(key))
    return next
  }

  /** Returns the parsed JSON body, or undefined when it is not JSON. Throws CloudflareError on non-2xx. */
  const send = async (path: string, init?: RequestInit) => {
    const method = init?.method ?? "GET"
    if (options.readOnly && method !== "GET") throw new Error(`Read-only Cloudflare client refused ${method} ${path}`)
    const res = await request(`${config.api}${path}`, timeout, {
      ...init,
      headers: {
        Authorization: `Bearer ${config.token}`,
        // FormData bodies need fetch to set the multipart boundary itself.
        ...(init?.body instanceof FormData ? {} : { "Content-Type": "application/json" }),
        ...init?.headers,
      },
    })
    const json = decodeJson(res.text)
    if (!res.ok) {
      const errors = json._tag === "Some" ? decodeErrors(json.value) : undefined
      throw new CloudflareError(
        res.status,
        errors?._tag === "Some" ? errors.value.errors.map((e) => e.code) : [],
        (errors?._tag === "Some" ? errors.value.errors[0]?.message : undefined) ?? `Cloudflare API ${res.status}`,
      )
    }
    return json._tag === "Some" ? json.value : undefined
  }

  /** Returns the `result` field, or undefined when absent. */
  const call = async (path: string, init?: RequestInit) => {
    const envelope = decodeResult(await send(path, init))
    return envelope._tag === "Some" ? envelope.value.result : undefined
  }

  const missing = async <T>(run: () => Promise<T>, fallback: T) => {
    const result = await run().then(
      (value) => ({ value }),
      (e: unknown) => {
        if (e instanceof CloudflareError && e.status === 404) return { value: fallback }
        throw e
      },
    )
    return result.value
  }

  /** Every item of a paginated list. A malformed page throws, so a partial list is never mistaken for the whole. */
  const listAll = async (path: string, page = 1): Promise<unknown[]> => {
    const separator = path.includes("?") ? "&" : "?"
    const decoded = decodePage(await send(`${path}${separator}per_page=100&page=${page}`))
    if (decoded._tag === "None") throw new Error(`Unexpected Cloudflare list response: ${path}`)
    // Some lists (KV namespaces) report only a total count.
    const info = decoded.value.result_info
    const pages = info?.total_pages ?? Math.ceil((info?.total_count ?? 0) / 100)
    return page >= pages ? [...decoded.value.result] : [...decoded.value.result, ...(await listAll(path, page + 1))]
  }

  const requireCreated = (result: unknown, what: string) => {
    const created = decodeCreated(result)
    if (created._tag === "None") throw new Error(`Unexpected Cloudflare response creating ${what}`)
    return created.value.id
  }

  const zoneID = () =>
    once("zone", async () => {
      const zones = decodeIDs(await call(`/zones?name=${encodeURIComponent(config.zone)}`))
      const first = zones._tag === "Some" ? zones.value[0] : undefined
      if (!first) throw new Error(`Zone not found: ${config.zone}`)
      return first.id
    })

  /** The id of the `omai-hostnames` KV namespace, or undefined when it does not exist. */
  const findKv = async () => {
    const list = decodeKvList(await listAll(`${account}/storage/kv/namespaces`))
    if (list._tag === "None") throw new Error("Unexpected Cloudflare KV namespace list")
    return list.value.find((n) => n.title === KV_TITLE)?.id
  }

  const kvID = () =>
    once("kv", async () => {
      const found = await findKv()
      if (!found) throw new Error(`KV namespace not found: ${KV_TITLE}`)
      return found
    })

  const kvPath = async (host: string) =>
    `${account}/storage/kv/namespaces/${await kvID()}/values/${encodeURIComponent(host)}`

  const requireHostname = (result: unknown): Hostname => {
    const decoded = decodeHostname(result)
    if (decoded._tag === "None") throw new Error("Unexpected Cloudflare custom hostname response")
    const h = decoded.value
    return {
      id: h.id,
      hostname: h.hostname,
      status: h.status,
      ssl: { status: h.ssl.status },
      ...(h.ownership_verification ? { ownership: h.ownership_verification } : {}),
    }
  }

  return {
    zoneID,
    kvID,
    findKv,

    createKv: async () =>
      requireCreated(
        await call(`${account}/storage/kv/namespaces`, { method: "POST", body: JSON.stringify({ title: KV_TITLE }) }),
        "KV namespace",
      ),

    namespaceExists: () =>
      missing(() => call(`${account}/workers/dispatch/namespaces/${config.namespace}`).then(() => true), false),

    createNamespace: async () => {
      await call(`${account}/workers/dispatch/namespaces`, {
        method: "POST",
        body: JSON.stringify({ name: config.namespace }),
      })
    },

    /** Whether an account-level Worker (not one in the dispatch namespace) exists. */
    workerExists: (name: string) =>
      missing(() => call(`${account}/workers/scripts/${name}/settings`).then(() => true), false),

    /** Every DNS record of the zone. */
    records: async () => {
      const records = decodeRecords(await listAll(`/zones/${await zoneID()}/dns_records`))
      if (records._tag === "None") throw new Error("Unexpected Cloudflare DNS record list")
      return records.value
    },

    createRecord: async (record: { type: string; name: string; content: string; proxied: boolean }) =>
      requireCreated(
        await call(`/zones/${await zoneID()}/dns_records`, { method: "POST", body: JSON.stringify(record) }),
        "DNS record",
      ),

    /** Worker routes of the zone; `script` is undefined for a bypass route. */
    routes: async () => {
      const routes = decodeRoutes(await call(`/zones/${await zoneID()}/workers/routes`))
      if (routes._tag === "None") throw new Error("Unexpected Cloudflare route list")
      return routes.value.map((r) => ({ id: r.id, pattern: r.pattern, script: r.script || undefined }))
    },

    /** Omit `script` for a bypass route, which turns Workers off for the pattern. */
    createRoute: async (pattern: string, script?: string) =>
      requireCreated(
        await call(`/zones/${await zoneID()}/workers/routes`, {
          method: "POST",
          body: JSON.stringify(script ? { pattern, script } : { pattern }),
        }),
        "route",
      ),

    /**
     * The custom hostname fallback origin, or undefined when none is set (a 404 or a null result). Any other shape
     * throws, so a changed response is never mistaken for "unset" and overwritten.
     */
    fallbackOrigin: async () => {
      const zone = await zoneID()
      const result = await missing(() => call(`/zones/${zone}/custom_hostnames/fallback_origin`), undefined)
      if (result === undefined || result === null) return undefined
      const decoded = decodeOrigin(result)
      if (decoded._tag === "None") throw new Error("Unexpected Cloudflare fallback origin response")
      return decoded.value.origin || undefined
    },

    setFallbackOrigin: async (origin: string) => {
      await call(`/zones/${await zoneID()}/custom_hostnames/fallback_origin`, {
        method: "PUT",
        body: JSON.stringify({ origin }),
      })
    },

    /** The script GET answers 200 with `script: null` for a missing script, so a 2xx alone does not mean it exists. */
    scriptExists: (name: string) =>
      missing(async () => decodeScript(await call(`${scripts}/${name}`))._tag === "Some", false),

    /** Uploads a 503 placeholder Worker tagged with the owning project so the name is reserved during the build. */
    claimScript: async (name: string, projectID: string) => {
      const form = new FormData()
      form.append(
        "metadata",
        new Blob(
          [
            JSON.stringify({
              main_module: "placeholder.mjs",
              compatibility_date: "2026-10-01",
            }),
          ],
          {
            type: "application/json",
          },
        ),
      )
      form.append(
        "placeholder.mjs",
        new Blob([PLACEHOLDER], { type: "application/javascript+module" }),
        "placeholder.mjs",
      )
      await call(`${scripts}/${name}`, { method: "PUT", body: form })
      await call(`${scripts}/${name}/tags`, {
        method: "PUT",
        body: JSON.stringify([`${OWNER_TAG}${projectID}`]),
      })
    },

    /** The project ID from the script's owner tag; undefined when the script or tag is missing. */
    scriptOwner: (name: string) =>
      missing(async () => {
        const tags = decodeTags(await call(`${scripts}/${name}/tags`))
        return tags._tag === "Some"
          ? tags.value.find((tag) => tag.startsWith(OWNER_TAG))?.slice(OWNER_TAG.length)
          : undefined
      }, undefined),

    deleteScript: (name: string) =>
      missing(() => call(`${scripts}/${name}`, { method: "DELETE" }).then(() => {}), undefined),

    /** True when the zone has a DNS record for exactly this host (the wildcard record does not count). */
    hasRecord: async (host: string) => {
      const records = decodeIDs(await call(`/zones/${await zoneID()}/dns_records?name=${encodeURIComponent(host)}`))
      return records._tag === "Some" && records.value.length > 0
    },

    kvGet: async (host: string) => {
      const res = await request(`${config.api}${await kvPath(host)}`, timeout, {
        headers: { Authorization: `Bearer ${config.token}` },
      })
      if (res.status === 404) return undefined
      if (!res.ok) throw new CloudflareError(res.status, [], `Cloudflare API ${res.status}`)
      return res.text
    },

    kvPut: async (host: string, value: string) => {
      await call(await kvPath(host), {
        method: "PUT",
        headers: { "Content-Type": "text/plain" },
        body: value,
      })
    },

    kvDelete: async (host: string) => {
      const path = await kvPath(host)
      await missing(() => call(path, { method: "DELETE" }).then(() => {}), undefined)
    },

    addHostname: async (host: string) =>
      requireHostname(
        await call(`/zones/${await zoneID()}/custom_hostnames`, {
          method: "POST",
          body: JSON.stringify({
            hostname: host,
            ssl: { method: "http", type: "dv" },
          }),
        }),
      ),

    /** The custom hostname for exactly `host`; the list filter can answer other hostnames, which are ignored. */
    getHostname: async (host: string) => {
      const result = await call(`/zones/${await zoneID()}/custom_hostnames?hostname=${encodeURIComponent(host)}`)
      if (!Array.isArray(result)) return undefined
      return result.map(requireHostname).find((item) => item.hostname === host)
    },

    deleteHostname: async (id: string) => {
      const zone = await zoneID()
      await missing(
        () =>
          call(`/zones/${zone}/custom_hostnames/${id}`, {
            method: "DELETE",
          }).then(() => {}),
        undefined,
      )
    },
  }
}

/** Fetches and reads the body within `timeout`; a request that runs out of time throws a plain CloudflareError. */
async function request(url: string, timeout: number, init: RequestInit) {
  const signal = AbortSignal.timeout(timeout)
  const read = async () => {
    const res = await fetch(url, { ...init, signal })
    return { status: res.status, ok: res.ok, text: await res.text() }
  }
  return read().catch((error: unknown) => {
    if (signal.aborted) throw new CloudflareError(0, [], "Cloudflare didn't respond in time.")
    throw error
  })
}
