import http, { type IncomingMessage, type ServerResponse } from "node:http"
import https from "node:https"
import { send } from "./http/http.js"
import { standIn } from "./keys.js"

export * as Gateway from "./gateway.js"

export type Match = { projectID: string; ref: string; origin: string; rest: string }

// Per connection, or ours alone: never forwarded upstream.
const DROP = new Set([
  "connection",
  "keep-alive",
  "proxy-connection",
  "transfer-encoding",
  "te",
  "trailer",
  "upgrade",
  "host",
  "x-omai-project-token",
])

/** `/internal/projects/<id>/gateway/<ref>/<base64url origin>/<rest>`, the address a VM's stand-in calls go to. */
export function match(pathname: string): Match | undefined {
  const found = /^\/internal\/projects\/([^/]+)\/gateway\/([^/]+)\/([^/]+)(\/.*)?$/.exec(pathname)
  if (!found) return undefined
  return {
    projectID: decodeURIComponent(found[1]!),
    ref: decodeURIComponent(found[2]!),
    origin: Buffer.from(found[3]!, "base64url").toString(),
    rest: found[4] ?? "/",
  }
}

/**
 * The model gateway: a VM holds a stand-in (`omai-gw.<ref>`) instead of a shared provider's secret or its user's
 * sign-in, and its calls come here with the project token. The real secret replaces every stand-in in the address and
 * headers, and the call goes on to the provider, streamed both ways, only to one of that provider's own hosts.
 */
export function make(deps: {
  /** The project's owner when `token` is its project token. */
  owner(projectID: string, token: string): Promise<string | undefined>
  /** The real secret behind `ref` for `userID`, with the hosts it may be sent to. */
  secret(userID: string, ref: string): Promise<{ secret: string; hosts: readonly string[] } | undefined>
}) {
  return async function handle(req: IncomingMessage, res: ServerResponse, found: Match) {
    const token = req.headers["x-omai-project-token"]
    const userID = typeof token === "string" ? await deps.owner(found.projectID, token) : undefined
    if (!userID) return send(res, 401)
    const resolved = await deps.secret(userID, found.ref)
    if (!resolved) return send(res, 404)
    const origin = URL.parse(found.origin)
    if (!origin || !allowed(origin, resolved.hosts)) return send(res, 403)
    const placeholder = standIn(found.ref)
    const swap = (text: string) => text.replaceAll(placeholder, resolved.secret)
    const query = new URL(req.url ?? "/", "http://internal").search
    const target = new URL(swap(`${origin.origin}${found.rest}${query}`))
    const headers = Object.fromEntries(
      Object.entries(req.headers).flatMap(([name, value]) =>
        DROP.has(name) || value === undefined
          ? []
          : [[name, Array.isArray(value) ? value.map(swap) : swap(value)] as const],
      ),
    )
    const upstream = (target.protocol === "https:" ? https.request : http.request)(target, {
      method: req.method,
      headers,
    })
    upstream.on("response", (response) => {
      res.writeHead(
        response.statusCode ?? 502,
        Object.fromEntries(Object.entries(response.headers).filter(([name]) => !DROP.has(name))),
      )
      // Each chunk goes on as it arrives, so streamed answers aren't held back.
      res.flushHeaders()
      response.pipe(res)
    })
    upstream.on("error", () => {
      if (res.headersSent) return res.destroy()
      send(res, 502)
    })
    res.on("close", () => upstream.destroy())
    req.pipe(upstream)
  }
}

/** One of the provider's hosts, over HTTPS (plain HTTP only to this machine, for local providers and tests). */
function allowed(origin: URL, hosts: readonly string[]) {
  if (!hosts.includes(origin.host)) return false
  if (origin.protocol === "https:") return true
  return origin.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname)
}
