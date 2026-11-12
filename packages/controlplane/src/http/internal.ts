export * as InternalHttp from "./internal.js"

import type { IncomingMessage, ServerResponse } from "node:http"
import { Schema } from "effect"
import type { Auth } from "../auth.js"
import type { Domains } from "../domains.js"
import { Refusal, type Publishing } from "../publishing.js"
import type { Keys } from "../keys.js"
import type { Projects } from "../projects.js"
import { bearer, body, bytes, jsonDecoder, send } from "./http.js"

// A half-size WebP screenshot is far smaller; anything above this is not one.
const THUMBNAIL_LIMIT = 4 * 1024 * 1024

const CredentialBody = jsonDecoder(
  Schema.Struct({
    integrationID: Schema.String,
    label: Schema.String,
    value: Schema.Record(Schema.String, Schema.Unknown),
    updatedAt: Schema.Number,
  }),
)
const Usage = jsonDecoder(
  Schema.Struct({
    steps: Schema.Array(
      Schema.Struct({
        providerID: Schema.String,
        modelID: Schema.String,
        inputTokens: Schema.Number,
        outputTokens: Schema.Number,
        at: Schema.Number,
      }),
    ).check(Schema.isMaxLength(200)),
  }),
)
const RefreshBody = jsonDecoder(Schema.Struct({ ref: Schema.String }))
const Name = jsonDecoder(Schema.Struct({ name: Schema.String }))
const Confirm = jsonDecoder(Schema.Struct({ confirm: Schema.String }))
const AddDomain = jsonDecoder(Schema.Struct({ hostname: Schema.String, primary: Schema.optional(Schema.Boolean) }))
const CheckDomain = jsonDecoder(Schema.Struct({ hostname: Schema.optional(Schema.String) }))
const REFUSAL_STATUS: Record<string, number> = {
  "not-configured": 503,
  "not-published": 404,
  invalid: 400,
  unsupported: 400,
  taken: 409,
  busy: 409,
  limit: 413,
  cloudflare: 502,
  other: 500,
}
const Summary = jsonDecoder(Schema.Struct({ title: Schema.String, at: Schema.Number }))
const Busy = jsonDecoder(Schema.Struct({ busy: Schema.Boolean, reasons: Schema.Array(Schema.String) }))

/**
 * Routes for the router and the VMs, on the internal port only (loopback locally, the private network in
 * production). No CORS: browsers never call these.
 */
export function make(deps: {
  auth: Auth
  projects: ReturnType<typeof Projects.make>
  keys: Keys
  publishing: Publishing
  domains: Domains
}) {
  /** The owner of the project whose token the request carries, or undefined (answer 401). */
  async function ownerOf(req: IncomingMessage, projectID: string) {
    const token = bearer(req)
    if (!token || !(await deps.projects.verifyProjectToken(projectID, token))) return undefined
    return deps.projects.owner(projectID)
  }

  const status = { ok: 204, stale: 409, forbidden: 404 } as const

  return async function handle(req: IncomingMessage, res: ServerResponse) {
    const requested = new URL(req.url ?? "/", "http://internal")
    const pathname = requested.pathname
    // A VM's model keys: the admin's shared providers and its owner's own credentials.
    const keys = /^\/internal\/projects\/([^/]+)\/keys$/.exec(pathname)
    if (keys && req.method === "GET") {
      const userID = await ownerOf(req, decodeURIComponent(keys[1]!))
      if (!userID) return send(res, 401)
      const [shared, personal] = await Promise.all([deps.keys.shared(), deps.keys.personal(userID)])
      // Without a known shared list the field is left out, so VMs keep the one they have.
      return send(res, 200, { ...(shared ? { shared } : {}), personal })
    }
    // A VM's sign-in is about to expire: it is refreshed here, once for all the VMs holding it.
    const refresh = /^\/internal\/projects\/([^/]+)\/credentials\/refresh$/.exec(pathname)
    if (refresh && req.method === "POST") {
      const userID = await ownerOf(req, decodeURIComponent(refresh[1]!))
      if (!userID) return send(res, 401)
      const input = await body(req, RefreshBody)
      if (!input) return send(res, 400)
      const value = await deps.keys.refresh(userID, input.ref)
      return value ? send(res, 200, value) : send(res, 404)
    }
    // A user's own credential changed on one of their VMs; the others pick it up from `keys`.
    const credential = /^\/internal\/projects\/([^/]+)\/credentials\/([^/]+)$/.exec(pathname)
    if (credential && (req.method === "PUT" || req.method === "DELETE")) {
      const userID = await ownerOf(req, decodeURIComponent(credential[1]!))
      if (!userID) return send(res, 401)
      const credentialID = decodeURIComponent(credential[2]!)
      if (req.method === "DELETE") {
        const at = Number(requested.searchParams.get("at"))
        if (!Number.isFinite(at)) return send(res, 400)
        return send(res, status[await deps.keys.remove(userID, credentialID, at)])
      }
      const input = await body(req, CredentialBody)
      if (!input) return send(res, 400)
      return send(res, status[await deps.keys.put(userID, { id: credentialID, ...input })])
    }
    const usage = /^\/internal\/projects\/([^/]+)\/usage$/.exec(pathname)
    if (usage && req.method === "POST") {
      const projectID = decodeURIComponent(usage[1]!)
      const userID = await ownerOf(req, projectID)
      if (!userID) return send(res, 401)
      const input = await body(req, Usage)
      if (!input) return send(res, 400)
      await deps.keys.usage(userID, projectID, input.steps)
      return send(res, 204)
    }
    // The VM's own facts it can't know at start, such as its preview's public address.
    const vm = /^\/internal\/projects\/([^/]+)\/vm$/.exec(pathname)
    if (vm && req.method === "GET") {
      const projectID = decodeURIComponent(vm[1]!)
      if (!(await ownerOf(req, projectID))) return send(res, 401)
      return send(res, 200, await deps.projects.vm(projectID))
    }
    // Publishing and domains: every Cloudflare call happens here, for the project whose token the request carries.
    const publish = /^\/internal\/projects\/([^/]+)\/(publish|domains)(?:\/(.+))?$/.exec(pathname)
    if (publish) {
      const projectID = decodeURIComponent(publish[1]!)
      const userID = await ownerOf(req, projectID)
      if (!userID) return send(res, 401)
      return publishing(req, res, requested, { projectID, userID, area: publish[2]!, rest: publish[3] }).catch(
        (error: unknown) => {
          if (!(error instanceof Refusal)) throw error
          if (res.headersSent) return
          send(res, REFUSAL_STATUS[error.kind] ?? 500, {
            kind: error.kind,
            message: error.message,
            ...(error.log ? { log: error.log } : {}),
          })
        },
      )
    }
    const session = /^\/internal\/sessions\/([^/]+)$/.exec(pathname)
    if (session && req.method === "GET")
      return send(
        res,
        (await deps.auth.sessionLive(decodeURIComponent(session[1]!), {
          admin: requested.searchParams.get("admin") === "1",
        }))
          ? 200
          : 404,
      )
    // The router's lookup for terminal connections, which carry only a one-time ticket the project's server checks.
    const host = /^\/internal\/projects\/([^/]+)\/host$/.exec(pathname)
    if (host && req.method === "GET") {
      const found = await deps.projects.host(decodeURIComponent(host[1]!))
      return found ? send(res, 200, { host: found }) : send(res, 404)
    }
    // The VM's busy report, every 10 s. Work in progress is activity too.
    const busy = /^\/internal\/projects\/([^/]+)\/busy$/.exec(pathname)
    if (busy && req.method === "POST") {
      const projectID = decodeURIComponent(busy[1]!)
      const token = bearer(req)
      if (!token || !(await deps.projects.verifyProjectToken(projectID, token))) return send(res, 401)
      const input = await body(req, Busy)
      if (!input) return send(res, 400)
      const report = { busy: input.busy, reasons: input.reasons.slice(0, 20).map((reason) => reason.slice(0, 100)) }
      deps.projects.lifecycle.recordBusy(projectID, report)
      if (report.busy) await deps.projects.lifecycle.touch(projectID)
      return send(res, 204)
    }
    // The router: user traffic to the project's VM.
    const activity = /^\/internal\/projects\/([^/]+)\/activity$/.exec(pathname)
    if (activity && req.method === "POST")
      return send(res, (await deps.projects.lifecycle.touch(decodeURIComponent(activity[1]!))) ? 204 : 404)
    // The router found the VM down: start it and answer once its server does.
    const wake = /^\/internal\/projects\/([^/]+)\/wake$/.exec(pathname)
    if (wake && req.method === "POST") {
      const result = await deps.projects.lifecycle.resume(decodeURIComponent(wake[1]!)).catch((error: unknown) => {
        console.error("waking a project for the router failed", error)
        return "failed" as const
      })
      if (result === "deleted") return send(res, 404)
      if (result === "not-ready") return send(res, 409)
      if (result === "failed") return send(res, 503)
      return send(res, 200, { host: result.host })
    }
    const summary = /^\/internal\/projects\/([^/]+)\/summary$/.exec(pathname)
    if (summary && req.method === "POST") {
      const projectID = decodeURIComponent(summary[1]!)
      const token = bearer(req)
      if (!token || !(await deps.projects.verifyProjectToken(projectID, token))) return send(res, 401)
      const input = await body(req, Summary)
      if (!input) return send(res, 400)
      await deps.projects.setSummary(projectID, { title: input.title.slice(0, 200), at: input.at })
      return send(res, 204)
    }
    const thumbnail = /^\/internal\/projects\/([^/]+)\/thumbnail$/.exec(pathname)
    if (thumbnail && req.method === "POST") {
      const projectID = decodeURIComponent(thumbnail[1]!)
      const token = bearer(req)
      if (!token || !(await deps.projects.verifyProjectToken(projectID, token))) return send(res, 401)
      const data = await bytes(req, THUMBNAIL_LIMIT)
      if (!data || data.length === 0) return send(res, 413)
      await deps.projects.setThumbnail(projectID, data)
      return send(res, 204)
    }
    send(res, 404)
  }

  async function publishing(
    req: IncomingMessage,
    res: ServerResponse,
    requested: URL,
    route: { projectID: string; userID: string; area: string; rest?: string },
  ) {
    const projectID = route.projectID
    const method = req.method
    if (route.area === "publish") {
      if (route.rest === undefined && method === "GET") return send(res, 200, await deps.publishing.status(projectID))
      if (route.rest === undefined && method === "DELETE") {
        const input = await body(req, Confirm)
        if (!input) return send(res, 400)
        await deps.publishing.remove(projectID, input.confirm)
        return send(res, 204)
      }
      if (route.rest === "available" && method === "POST") {
        const input = await body(req, Name)
        if (!input) return send(res, 400)
        return send(res, 200, await deps.publishing.available(projectID, input.name))
      }
      if (route.rest === "claim" && method === "POST") {
        const input = await body(req, Name)
        if (!input) return send(res, 400)
        return send(res, 200, await deps.publishing.claim(projectID, route.userID, input.name))
      }
      if (route.rest === "release" && method === "POST") {
        await deps.publishing.release(projectID)
        return send(res, 204)
      }
      if (route.rest === "deploy" && method === "POST") {
        // The VM going away (a cancel) stops the upload.
        const abort = new AbortController()
        res.on("close", () => {
          if (!res.writableEnded) abort.abort()
        })
        const result = await deps.publishing.deploy(projectID, {
          body: req as AsyncIterable<Buffer>,
          kind: requested.searchParams.get("kind") ?? "",
          entry: requested.searchParams.get("entry") ?? undefined,
          signal: abort.signal,
        })
        return send(res, 200, result)
      }
      return send(res, 404)
    }
    if (route.rest === undefined && method === "GET") return send(res, 200, await deps.domains.list(projectID))
    if (route.rest === undefined && method === "POST") {
      const input = await body(req, AddDomain)
      if (!input) return send(res, 400)
      return send(res, 200, await deps.domains.add(projectID, input.hostname, input.primary))
    }
    if (route.rest === "check" && method === "POST") {
      const input = await body(req, CheckDomain)
      if (!input) return send(res, 400)
      return send(res, 200, await deps.domains.check(projectID, input.hostname))
    }
    const primary = /^([^/]+)\/primary$/.exec(route.rest ?? "")
    if (primary && method === "POST")
      return send(res, 200, await deps.domains.setPrimary(projectID, decodeURIComponent(primary[1]!)))
    if (route.rest && !route.rest.includes("/") && method === "DELETE")
      return send(res, 200, await deps.domains.remove(projectID, decodeURIComponent(route.rest)))
    send(res, 404)
  }
}
