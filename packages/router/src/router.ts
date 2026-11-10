import http, { type IncomingMessage, type ServerResponse } from "node:http"
import https from "node:https"
import net from "node:net"
import type { Duplex } from "node:stream"
import tls from "node:tls"
import { SignedToken } from "@opencode/util/signed-token"

export * as Router from "./router.js"

export type Options = {
  port: number
  publicKey: string
  appOrigin: string
  controlPlaneUrl: string
  /** How long a session's "live" answer is trusted. Default 30 s. */
  cacheMs?: number
  now?: () => number
  /** How long a request waits for a paused VM to start. Default 95 s (the control plane's 90 s, plus margin). */
  wakeTimeoutMs?: number
  hostname?: string
}

// How long a session the control plane last confirmed stays usable while it can't be reached.
const OUTAGE_GRACE_MS = 5 * 60_000

// Activity reaches the control plane at most this often per project; its idle limit is 2 minutes.
const ACTIVITY_EVERY_MS = 15_000

// A VM that doesn't accept a connection within this is treated as down.
const CONNECT_TIMEOUT_MS = 5_000

// Errors that mean nothing listens at the VM's address: it is paused (or starting).
const DOWN = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
])

// The platform server (provider keys for every user) is reached only by admins' Settings > Providers and Models,
// so only the routes those pages use pass: never its sessions, shell, files or terminals.
const PLATFORM = "platform"
const PLATFORM_PATHS = [
  /^\/api\/info$/,
  /^\/api\/event$/,
  /^\/api\/config(\/.*)?$/,
  /^\/api\/provider(\/.*)?$/,
  /^\/api\/model(\/.*)?$/,
  /^\/api\/integration(\/.*)?$/,
  /^\/api\/credential(\/.*)?$/,
]
// Reads the app makes while it loads any server; the platform server has no projects or sessions to show.
const PLATFORM_READS = [/^\/api\/location$/, /^\/api\/project$/, /^\/api\/session\/active$/, /^\/api\/vcs$/]

function platformAllowed(method: string | undefined, pathname: string) {
  if (PLATFORM_PATHS.some((pattern) => pattern.test(pathname))) return true
  return (method === "GET" || method === "HEAD") && PLATFORM_READS.some((pattern) => pattern.test(pathname))
}

// Sent on a timer by an open app whether or not anyone uses it.
const HEARTBEATS = new Set(["/api/rpc/omai.preview/watch"])

/**
 * Whether a request is someone doing something. An open app keeps reading (health checks, the event stream, refreshes)
 * and sends heartbeats on its own, so reads and heartbeats don't count; someone reading is reported by the app itself.
 */
function userAction(method: string | undefined, pathname: string) {
  if (method === "GET" || method === "HEAD") return false
  return !HEARTBEATS.has(pathname)
}

/** `token`: the request carried a VM token, rather than only a ticket the project's server checks itself. */
type Resolved = { target: URL; projectID: string; token: boolean }

// Hop-by-hop headers are per connection and never forwarded.
const HOP = new Set(["connection", "keep-alive", "proxy-connection", "transfer-encoding", "te", "trailer", "upgrade"])

/**
 * Forwards `/vm/<projectID>/<rest>` to the project's server, at the host named in the VM token. Tokens that are
 * missing, invalid or for another project get 404, so the router never says whether a project exists.
 */
export async function start(options: Options) {
  const cacheMs = options.cacheMs ?? 30_000
  const now = options.now ?? (() => Date.now())
  // `confirmed`: when the control plane last said the session is live.
  const sessions = new Map<string, { live: boolean; at: number; confirmed: number }>()

  /** Whether a session is live; for the platform server, also that its user is still an admin. */
  async function sessionLive(sid: string, admin = false) {
    const key = `${sid}:${admin}`
    const cached = sessions.get(key)
    if (cached && now() - cached.at < cacheMs) return cached.live
    const query = admin ? "?admin=1" : ""
    const answer = await fetch(`${options.controlPlaneUrl}/internal/sessions/${encodeURIComponent(sid)}${query}`, {
      signal: AbortSignal.timeout(5000),
    }).then(
      (res) => (res.status === 200 ? "live" : res.status === 404 ? "ended" : "unknown"),
      () => "unknown" as const,
    )
    // The control plane unreachable (down, restarting): a session it said was live stays live for up to 5 minutes,
    // so open projects keep working. Never for the platform server: its admin check fails closed.
    const graced = !admin && !!cached?.live && now() - cached.confirmed < OUTAGE_GRACE_MS
    const live = answer === "unknown" ? graced : answer === "live"
    sessions.set(key, { live, at: now(), confirmed: answer === "live" ? now() : (cached?.confirmed ?? 0) })
    return live
  }

  const hosts = new Map<string, { host: string | undefined; at: number }>()

  /** A running project's server address, from the control plane; cached like sessions. */
  async function projectHost(projectID: string) {
    const cached = hosts.get(projectID)
    if (cached && Date.now() - cached.at < cacheMs) return cached.host
    const host = await fetch(`${options.controlPlaneUrl}/internal/projects/${encodeURIComponent(projectID)}/host`, {
      signal: AbortSignal.timeout(5000),
    })
      .then(async (res) => (res.ok ? readHost(await res.text()) : undefined))
      .catch(() => undefined)
    hosts.set(projectID, { host, at: Date.now() })
    return host
  }

  const reported = new Map<string, number>()

  /** Tells the control plane the project is in use, so its VM isn't paused. Fire and forget. */
  function activity(projectID: string) {
    const last = reported.get(projectID)
    if (last !== undefined && Date.now() - last < ACTIVITY_EVERY_MS) return
    reported.set(projectID, Date.now())
    void fetch(`${options.controlPlaneUrl}/internal/projects/${encodeURIComponent(projectID)}/activity`, {
      method: "POST",
      signal: AbortSignal.timeout(5000),
    }).catch(() => undefined)
  }

  const waking = new Map<string, Promise<number | undefined>>()

  /**
   * Asks the control plane to start the project's paused VM; concurrent requests share one call. Resolves to undefined
   * once it serves at `host` again, or to the status to answer with.
   */
  function wake(projectID: string, host: string) {
    const pending = waking.get(projectID)
    if (pending) return pending
    const run = fetch(`${options.controlPlaneUrl}/internal/projects/${encodeURIComponent(projectID)}/wake`, {
      method: "POST",
      signal: AbortSignal.timeout(options.wakeTimeoutMs ?? 95_000),
    })
      .then(async (res) => {
        if (res.status === 404) return 404
        if (!res.ok) return 503
        // The token names the address; a VM that came back elsewhere needs a new token from the control plane.
        return readHost(await res.text()) === host ? undefined : 404
      })
      .catch(() => 503)
      .finally(() => waking.delete(projectID))
    waking.set(projectID, run)
    return run
  }

  /** The upstream URL and project, or the status to answer with. */
  async function resolve(req: IncomingMessage): Promise<Resolved | number> {
    const url = new URL(req.url ?? "/", "http://router")
    const match = /^\/vm\/([^/]+)(\/.*)?$/.exec(url.pathname)
    if (!match) return 404
    const projectID = decodeURIComponent(match[1]!)
    const rest = new URL(`${match[2] ?? "/"}${url.search}`, "http://vm")
    const claims = SignedToken.verify(credential(req, url) ?? "", options.publicKey)
    if (claims?.typ === "vm" && claims.pid === projectID) {
      if (projectID === PLATFORM && !platformAllowed(req.method, rest.pathname)) return 404
      if (!(await sessionLive(claims.sid, projectID === PLATFORM))) return 401
      // The platform server always works in its own folder: a requested one could load config and plugins from elsewhere.
      if (projectID === PLATFORM) rest.searchParams.delete("location[directory]")
      return { target: new URL(rest.pathname + rest.search, claims.host), projectID, token: true }
    }
    if (projectID === PLATFORM) return 404
    // Browsers cannot put a header on a WebSocket, so terminals connect with only a one-time ticket in the address.
    // The project's server checks that ticket itself, so these addresses pass without a token, as they do there.
    if (claims || !ticketPath(rest)) return 404
    const host = await projectHost(projectID)
    if (!host) return 404
    return { target: new URL(rest.pathname + rest.search, host), projectID, token: false }
  }

  function cors(req: IncomingMessage): Record<string, string> {
    if (req.headers.origin !== options.appOrigin) return {}
    return { "access-control-allow-origin": options.appOrigin, vary: "Origin" }
  }

  async function handle(req: IncomingMessage, res: ServerResponse) {
    if (req.method === "OPTIONS") return preflight(req, res)
    const resolved = await resolve(req)
    if (typeof resolved === "number") return fail(req, res, resolved)
    // Only someone doing something counts as activity, or wakes a paused VM: an open app keeps polling every project
    // it opened, and those reads must neither keep VMs awake nor start the ones the user has left.
    const acting = resolved.token && resolved.projectID !== PLATFORM && userAction(req.method, resolved.target.pathname)
    if (acting) activity(resolved.projectID)
    forward(req, res, resolved, acting)
  }

  function fail(req: IncomingMessage, res: ServerResponse, status: number) {
    const error = { 401: "unauthenticated", 404: "not-found", 502: "unreachable", 503: "unavailable" }[status]
    res.writeHead(status, { ...cors(req), "content-type": "application/json" })
    res.end(JSON.stringify({ error: error ?? "unavailable" }))
  }

  /**
   * Sends the request to the VM. The body is only read once the VM accepted the connection, so when it is down (paused)
   * the VM can be woken and the same request sent again.
   */
  function forward(req: IncomingMessage, res: ServerResponse, resolved: Resolved, retry: boolean) {
    const target = resolved.target
    const upstream = (target.protocol === "https:" ? https.request : http.request)(target, {
      method: req.method,
      headers: forwardHeaders(req, target),
    })
    const state = { connected: false }
    const timer = setTimeout(
      () => upstream.destroy(Object.assign(new Error("connect timeout"), { code: "ETIMEDOUT" })),
      CONNECT_TIMEOUT_MS,
    )
    const connected = () => {
      clearTimeout(timer)
      state.connected = true
      req.pipe(upstream)
    }
    upstream.on("socket", (socket) => (socket.connecting ? socket.once("connect", connected) : connected()))
    upstream.on("response", (response) => {
      const headers = Object.fromEntries(
        Object.entries(response.headers).filter(
          ([name]) =>
            !HOP.has(name) && name !== "access-control-allow-origin" && name !== "access-control-allow-credentials",
        ),
      )
      res.writeHead(response.statusCode ?? 502, { ...headers, ...cors(req) })
      // Flush every chunk as it arrives so event streams are not held back.
      res.flushHeaders()
      response.pipe(res)
    })
    upstream.on("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer)
      if (res.headersSent) return res.destroy()
      if (state.connected || !DOWN.has(error.code ?? "")) return fail(req, res, 502)
      // Down, and nothing to wake it for: answer at once, so the app shows it as unavailable.
      if (!retry) return fail(req, res, 503)
      void wake(resolved.projectID, target.origin).then((status) =>
        status === undefined ? forward(req, res, resolved, false) : fail(req, res, status),
      )
    })
    res.on("close", () => {
      clearTimeout(timer)
      upstream.destroy()
    })
  }

  function preflight(req: IncomingMessage, res: ServerResponse) {
    if (req.headers.origin !== options.appOrigin) {
      res.writeHead(403)
      return res.end()
    }
    res.writeHead(204, {
      ...cors(req),
      "access-control-allow-methods": "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS",
      "access-control-allow-headers": req.headers["access-control-request-headers"] ?? "authorization, content-type",
      "access-control-max-age": "86400",
    })
    res.end()
  }

  async function upgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
    socket.on("error", () => socket.destroy())
    const resolved = await resolve(req)
    if (typeof resolved === "number") {
      socket.end(`HTTP/1.1 ${resolved} ${resolved === 401 ? "Unauthorized" : "Not Found"}\r\nconnection: close\r\n\r\n`)
      return
    }
    // Opening a terminal with a VM token is someone using the project; ticket-only connections are not trusted to be.
    const acting = resolved.token && resolved.projectID !== PLATFORM
    if (acting) activity(resolved.projectID)
    pipeUpgrade(req, socket, head, resolved, acting)
  }

  // A raw TCP pipe: the upgrade request is replayed to the VM and both directions are copied byte for byte.
  function pipeUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, resolved: Resolved, retry: boolean) {
    const target = resolved.target
    const port = Number(target.port || (target.protocol === "https:" ? 443 : 80))
    const upstream =
      target.protocol === "https:"
        ? tls.connect({ host: target.hostname, port, servername: target.hostname })
        : net.connect({ host: target.hostname, port })
    const state = { connected: false }
    const timer = setTimeout(
      () => upstream.destroy(Object.assign(new Error("connect timeout"), { code: "ETIMEDOUT" })),
      CONNECT_TIMEOUT_MS,
    )
    upstream.once("connect", () => {
      clearTimeout(timer)
      state.connected = true
      const headers = {
        ...forwardHeaders(req, target),
        connection: "Upgrade",
        upgrade: req.headers.upgrade ?? "websocket",
      }
      const lines = Object.entries(headers).flatMap(([name, value]) =>
        (Array.isArray(value) ? value : [value ?? ""]).map((item) => `${name}: ${item}`),
      )
      upstream.write(`${req.method} ${target.pathname}${target.search} HTTP/1.1\r\n${lines.join("\r\n")}\r\n\r\n`)
      if (head.length > 0) upstream.write(head)
      socket.on("close", () => upstream.destroy())
      upstream.on("close", () => socket.destroy())
      upstream.pipe(socket).pipe(upstream)
      // What the user sends (terminal keystrokes) is activity; what the VM sends isn't. A ticket-only connection counts
      // once the VM accepts its ticket (101), which only a signed-in user could have asked for: otherwise typing in
      // just the terminal lets the VM pause under it.
      if (resolved.projectID === PLATFORM) return
      const accepted = { value: resolved.token }
      if (!accepted.value)
        upstream.once("data", (chunk: Buffer) => {
          accepted.value = /^HTTP\/1\.[01] 101/.test(chunk.toString("latin1", 0, 16))
          if (accepted.value) activity(resolved.projectID)
        })
      socket.on("data", () => {
        if (accepted.value) activity(resolved.projectID)
      })
    })
    upstream.on("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer)
      if (!retry || state.connected || !DOWN.has(error.code ?? "")) return socket.destroy()
      void wake(resolved.projectID, target.origin).then((status) => {
        if (status === undefined) return pipeUpgrade(req, socket, head, resolved, false)
        socket.end(
          `HTTP/1.1 ${status} ${status === 404 ? "Not Found" : "Service Unavailable"}\r\nconnection: close\r\n\r\n`,
        )
      })
    })
  }

  const server = http.createServer((req, res) => {
    void handle(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500)
      res.end()
    })
  })
  // Node cuts off a request whose body is still arriving after 5 minutes. A big zip over a slow line takes longer, so
  // bodies get an hour; headers still have to arrive within Node's 60 s.
  server.requestTimeout = 60 * 60_000
  server.on("upgrade", (req, socket, head) => {
    void upgrade(req, socket, head).catch(() => socket.destroy())
  })
  await new Promise<void>((resolveListen) => server.listen(options.port, options.hostname ?? "0.0.0.0", resolveListen))
  const address = server.address()
  return {
    port: typeof address === "object" && address ? address.port : options.port,
    close: () =>
      new Promise<void>((resolveClose) => {
        server.closeAllConnections()
        server.close(() => resolveClose())
      }),
  }
}

// The addresses the project's server accepts with a one-time ticket instead of credentials (see `hasPtyConnectTicketURL`,
// `hasPersistentPtyConnectTicketURL` and `hasMcpClientTicketURL` in @opencode/protocol; a router test keeps them equal).
const TICKET_PATHS = [
  /^\/api\/pty\/[^/]+\/connect$/,
  /^\/api\/experimental\/persistent-pty\/[^/]+\/connect$/,
  /^\/api\/experimental\/client-mcp$/,
]

/** Whether `url` (on the project's server) is one that a one-time ticket authorises by itself. */
export function ticketPath(url: URL) {
  return !!url.searchParams.get("ticket") && TICKET_PATHS.some((pattern) => pattern.test(url.pathname))
}

function readHost(text: string) {
  const parsed: unknown = JSON.parse(text)
  if (typeof parsed !== "object" || parsed === null || !("host" in parsed) || typeof parsed.host !== "string")
    return undefined
  return parsed.host
}

/** The VM token, from `Authorization: Basic base64(omai:<token>)` or the `auth_token` query in the same form. */
function credential(req: IncomingMessage, url: URL) {
  const encoded = url.searchParams.get("auth_token") ?? /^Basic\s+(.+)$/i.exec(req.headers.authorization ?? "")?.[1]
  if (!encoded) return undefined
  const decoded = Buffer.from(encoded, "base64").toString("utf8")
  const separator = decoded.indexOf(":")
  if (separator === -1 || decoded.slice(0, separator) !== "omai") return undefined
  return decoded.slice(separator + 1)
}

function forwardHeaders(req: IncomingMessage, target: URL) {
  const platform = /^\/vm\/platform(\/|$)/.test(new URL(req.url ?? "/", "http://router").pathname)
  const headers = Object.fromEntries(
    Object.entries(req.headers).filter(([name]) => !HOP.has(name) && !(platform && name === "x-omai-directory")),
  )
  return { ...headers, host: target.host }
}
