// The preview's own origin: a listener that forwards everything to the dev server unchanged, except that HTML gets
// one script tag, frame blockers are dropped, and Host and Origin read as the dev server's own so its host checks pass.

import { createReadStream } from "node:fs"
import { stat } from "node:fs/promises"
import { createServer, request, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http"
import { connect, type Socket } from "node:net"
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib"
import type { Readable } from "node:stream"
import path from "node:path"
import { ProjectVmBusy } from "../project-vm/busy.js"
import { startingPage } from "./starting-page.js"
import { TYPES } from "./static.js"

export type Upstream = { readonly kind: "port"; readonly port: number } | { readonly kind: "down" }

export interface Proxy {
  readonly port: number
  close(): Promise<void>
}

export interface ProxyInput {
  hostname: string
  /** 0 picks a free port. */
  port: number
  upstream: () => Upstream
  /** Without it the preview is open to whoever can reach the port, like any local dev server. */
  auth?: {
    verify(cookie: string | undefined): boolean
    /** The cookie value for a valid one-time ticket. */
    exchange(ticket: string): string | undefined
  }
  /** The bridge script's source for the app origin that entered the preview. */
  bridge: (parent: string | undefined) => string
  /** The visual editor's source for that origin, which the bridge loads only while visual editing is on. */
  visual: (parent: string | undefined) => string
  /**
   * The file of an image the visual editor uploaded at this path, if any. The proxy serves it itself, because a dev
   * server may not serve a file added to its public folder after it started; a file that is gone falls through.
   */
  uploads: (pathname: string) => string | undefined
  /** Server-sent events for pages in the preview, like `reload`. */
  events: { subscribe(listener: (event: string) => void): () => void }
  /**
   * The preview has its own public site (a VM's code.run address), so the app's frame is cross-site: its cookies must
   * be `SameSite=None; Secure; Partitioned` or the browser drops them. Northflank serves it over HTTPS.
   */
  crossSite?: boolean
}

const AUTH_COOKIE = "omai_preview"

const PARENT_COOKIE = "omai_parent"

const TAG = '<script src="/__omai/bridge.js"></script>'

/** Opens the preview listener. */
export async function openProxy(input: ProxyInput): Promise<Proxy> {
  const sockets = new Set<Socket>()
  const server = createServer((req, res) => handle(input, req, res))
  server.on("upgrade", (req: IncomingMessage, socket: Socket, head: Buffer) => upgrade(input, req, socket, head))
  server.on("connection", (socket) => {
    sockets.add(socket)
    socket.once("close", () => sockets.delete(socket))
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(input.port, input.hostname, () => resolve())
  })
  const address = server.address()

  return {
    port: typeof address === "object" && address ? address.port : input.port,
    close: () =>
      new Promise((resolve) => {
        sockets.forEach((socket) => socket.destroy())
        server.close(() => resolve())
      }),
  }
}

function handle(input: ProxyInput, req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", "http://preview")

  if (url.pathname === "/__omai/enter") return enter(input, req, url, res)

  if (input.auth && !input.auth.verify(cookie(req.headers, AUTH_COOKIE)))
    return send(res, 401, "text/plain", "Open this preview from O M A I +.")

  if (url.pathname === "/__omai/bridge.js")
    return send(res, 200, "text/javascript", input.bridge(cookie(req.headers, PARENT_COOKIE)), {
      "cache-control": "no-store",
    })

  if (url.pathname === "/__omai/visual.js")
    return send(res, 200, "text/javascript", input.visual(cookie(req.headers, PARENT_COOKIE)), {
      "cache-control": "no-store",
    })

  if (url.pathname === "/__omai/events") return events(input, req, res)

  if (url.pathname === "/__omai/logo") return logo(req, res)
  const upload = req.method === "GET" || req.method === "HEAD" ? input.uploads(url.pathname) : undefined

  if (upload) return void serveUpload(input, req, res, upload)
  toUpstream(input, req, res)
}

function toUpstream(input: ProxyInput, req: IncomingMessage, res: ServerResponse) {
  const target = input.upstream()
  // Someone is viewing the app: on a MicroVM this keeps it from pausing.
  ProjectVmBusy.touch("preview")

  if (target.kind === "down") return starting(res)
  forward(req, res, target.port)
}

async function serveUpload(input: ProxyInput, req: IncomingMessage, res: ServerResponse, file: string) {
  const found = await stat(file).then(
    (info) => info.isFile(),
    () => false,
  )

  if (!found) return toUpstream(input, req, res)
  res.writeHead(200, {
    "content-type": TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  })

  if (req.method === "HEAD") return res.end()
  createReadStream(file).pipe(res)
}

// The entry point the panel loads first: remembers the app origin for the bridge, trades the ticket for the auth
// cookie when the preview needs one, then goes to the page.
function enter(input: ProxyInput, req: IncomingMessage, url: URL, res: ServerResponse) {
  const to = url.searchParams.get("to") ?? "/"
  const parent = url.searchParams.get("parent")
  const cookies: string[] = []
  const attributes = input.crossSite ? "Path=/; HttpOnly; SameSite=None; Secure; Partitioned" : "Path=/; HttpOnly; SameSite=Lax"

  // A browser that already entered keeps its cookie: the frame reloads its first address, whose one-time ticket is
  // spent by then, so only a browser without a valid cookie needs a fresh ticket.
  if (input.auth && !input.auth.verify(cookie(req.headers, AUTH_COOKIE))) {
    const value = input.auth.exchange(url.searchParams.get("ticket") ?? "")

    if (!value) return send(res, 401, "text/plain", "This preview link has expired. Reopen it from O M A I +.")
    cookies.push(`${AUTH_COOKIE}=${value}; ${attributes}`)
  }

  if (parent) cookies.push(`${PARENT_COOKIE}=${encodeURIComponent(parent)}; ${attributes}`)
  res.writeHead(302, { location: to.startsWith("/") && !to.startsWith("//") ? to : "/", "set-cookie": cookies })
  res.end()
}

function events(input: ProxyInput, req: IncomingMessage, res: ServerResponse) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" })
  res.write(": ready\n\n")
  const unsubscribe = input.events.subscribe((event) => res.write(`event: ${event}\ndata: \n\n`))
  const keepAlive = setInterval(() => res.write(": keep-alive\n\n"), 15_000)
  req.once("close", () => {
    clearInterval(keepAlive)
    unsubscribe()
  })
}

// The brand icon lives with the app, not the preview, so the preview points at the app that entered it.
function logo(req: IncomingMessage, res: ServerResponse) {
  const parent = URL.parse(cookie(req.headers, PARENT_COOKIE) ?? "")

  if (!parent || !/^https?:$/.test(parent.protocol)) return send(res, 404, "text/plain", "")
  res.writeHead(302, { location: `${parent.origin}/web-app-manifest-192x192.png`, "cache-control": "no-store" })
  res.end()
}

function starting(res: ServerResponse) {
  send(res, 200, "text/html; charset=utf-8", startingPage, { "x-omai-starting": "1", "cache-control": "no-store" })
}

function forward(req: IncomingMessage, res: ServerResponse, port: number) {
  const headers = upstreamHeaders(req.headers, port)
  // Pages come back uncompressed so the script tag can go in; everything else streams through as it is.
  if (accepts(req.headers, "text/html")) headers["accept-encoding"] = "identity"
  const out = request({ host: "127.0.0.1", port, method: req.method, path: req.url, headers }, (upstream) => {
    const responseHeaders = downstreamHeaders(upstream.headers)
    const type = String(upstream.headers["content-type"] ?? "")
    const body = req.method !== "HEAD" && upstream.statusCode !== 204 && upstream.statusCode !== 304

    if (!body || !type.includes("text/html")) {
      res.writeHead(upstream.statusCode ?? 502, responseHeaders)
      upstream.pipe(res)
      return
    }
    void collect(decode(upstream)).then(
      (html) => {
        const injected = Buffer.from(inject(html))
        delete responseHeaders["content-encoding"]
        delete responseHeaders["transfer-encoding"]
        responseHeaders["content-length"] = String(injected.length)
        res.writeHead(upstream.statusCode ?? 200, responseHeaders)
        res.end(injected)
      },
      () => res.destroy(),
    )
  })
  out.on("error", () => {
    if (res.headersSent) return res.destroy()

    if (accepts(req.headers, "text/html")) return starting(res)
    send(res, 502, "text/plain", "The dev server isn't answering.")
  })
  req.pipe(out)
}

// WebSocket upgrades, for hot reload: the same header rewrite, then raw bytes both ways.
function upgrade(input: ProxyInput, req: IncomingMessage, socket: Socket, head: Buffer) {
  const target = input.upstream()

  if ((input.auth && !input.auth.verify(cookie(req.headers, AUTH_COOKIE))) || target.kind === "down")
    return socket.destroy()
  const upstream = connect(target.port, "127.0.0.1", () => {
    const headers = upstreamHeaders(req.headers, target.port)
    const lines = Object.entries(headers).flatMap(([name, value]) =>
      value === undefined ? [] : (Array.isArray(value) ? value : [value]).map((item) => `${name}: ${item}`),
    )
    upstream.write([`${req.method} ${req.url} HTTP/1.1`, ...lines, "", ""].join("\r\n"))

    if (head.length > 0) upstream.write(head)
    upstream.pipe(socket)
    socket.pipe(upstream)
  })
  const close = () => {
    upstream.destroy()
    socket.destroy()
  }
  upstream.on("error", close)
  socket.on("error", close)
  upstream.on("close", close)
  socket.on("close", close)
}

/** The script tag right after `<head…>`, else after `<html…>`, else at the very start. */
export function inject(html: string) {
  const head = /<head(\s[^>]*)?>/i.exec(html) ?? /<html(\s[^>]*)?>/i.exec(html)

  if (!head) return TAG + html
  const at = head.index + head[0].length

  return html.slice(0, at) + TAG + html.slice(at)
}

function upstreamHeaders(headers: IncomingHttpHeaders, port: number) {
  const origin = `http://127.0.0.1:${port}`
  const out: Record<string, string | string[] | undefined> = { ...headers, host: `127.0.0.1:${port}` }

  if (headers.origin) out.origin = origin

  if (typeof headers.referer === "string") {
    const referer = URL.parse(headers.referer)

    if (referer) out.referer = origin + referer.pathname + referer.search
  }
  const cookies = withoutPreviewCookies(headers.cookie)

  if (cookies) out.cookie = cookies

  if (!cookies) delete out.cookie

  return out
}

function downstreamHeaders(headers: IncomingHttpHeaders) {
  const out: Record<string, string | string[] | undefined> = { ...headers }
  delete out["x-frame-options"]

  for (const name of ["content-security-policy", "content-security-policy-report-only"]) {
    const value = out[name]

    if (typeof value !== "string") continue
    const kept = value
      .split(";")
      .map((part) => part.trim())
      .filter((part) => part && !/^frame-ancestors\b/i.test(part))
      .join("; ")

    if (kept) out[name] = kept

    if (!kept) delete out[name]
  }

  return out
}

function decode(stream: IncomingMessage): Readable {
  const encoding = String(stream.headers["content-encoding"] ?? "").toLowerCase()

  if (encoding === "gzip" || encoding === "x-gzip") return stream.pipe(createGunzip())

  if (encoding === "br") return stream.pipe(createBrotliDecompress())

  if (encoding === "deflate") return stream.pipe(createInflate())

  return stream
}

function collect(stream: Readable) {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = []
    stream.on("data", (chunk: Buffer) => chunks.push(chunk))
    stream.once("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
    stream.once("error", reject)
  })
}

const accepts = (headers: IncomingHttpHeaders, type: string) => String(headers.accept ?? "").includes(type)

function cookie(headers: IncomingHttpHeaders, name: string) {
  const match = String(headers.cookie ?? "")
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))

  return match === undefined ? undefined : decodeURIComponent(match.slice(name.length + 1))
}

// The preview's own cookies stay with the proxy; the app only sees its own.
function withoutPreviewCookies(header: string | undefined) {
  return String(header ?? "")
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part && !part.startsWith(`${AUTH_COOKIE}=`) && !part.startsWith(`${PARENT_COOKIE}=`))
    .join("; ")
}

function send(res: ServerResponse, status: number, type: string, body: string, headers: Record<string, string> = {}) {
  res.writeHead(status, { "content-type": type, "content-length": String(Buffer.byteLength(body)), ...headers })
  res.end(body)
}
