import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { tmpdir } from "node:os"
import path from "node:path"
import { SignedToken } from "@opencode/util/signed-token"
import { Router } from "../src/router.js"
import { hasMcpClientTicketURL } from "@opencode/protocol/groups/mcp"
import { hasPersistentPtyConnectTicketURL } from "@opencode/protocol/groups/persistent-pty"
import { hasPtyConnectTicketURL } from "@opencode/protocol/groups/pty"

const keys = SignedToken.generateKeyPair()
const APP = "http://app.test"
const cleanup: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
})

function listen(server: Server) {
  return new Promise<number>((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      cleanup.push(() => new Promise<void>((done) => server.close(() => done())))
      cleanup.push(() => server.closeAllConnections())
      resolve(typeof address === "object" && address ? address.port : 0)
    }),
  )
}

/** The control plane's internal routes; the test decides which sessions are live and what waking a VM does. */
async function controlPlane() {
  const live = new Set(["s1"])
  const admins = new Set(["s1"])
  const hosts = new Map<string, string>()
  const wakes = new Map<string, () => Promise<{ status: number; host?: string }>>()
  const calls = { count: 0, hosts: 0, wakes: 0, activity: [] as string[] }
  const state = { down: false }
  const port = await listen(
    createServer((req, res) => {
      // Down: the connection drops without an answer, as when nothing listens.
      if (state.down) return req.socket.destroy()
      const host = /^\/internal\/projects\/([^/]+)\/host$/.exec(req.url ?? "")
      if (host) {
        calls.hosts++
        const found = hosts.get(host[1]!)
        res.statusCode = found ? 200 : 404
        return res.end(found ? JSON.stringify({ host: found }) : undefined)
      }
      const activity = /^\/internal\/projects\/([^/]+)\/activity$/.exec(req.url ?? "")
      if (activity && req.method === "POST") {
        calls.activity.push(activity[1]!)
        res.statusCode = 204
        return res.end()
      }
      const wake = /^\/internal\/projects\/([^/]+)\/wake$/.exec(req.url ?? "")
      if (wake && req.method === "POST") {
        calls.wakes++
        const run = wakes.get(wake[1]!) ?? (async (): Promise<{ status: number; host?: string }> => ({ status: 503 }))
        void run().then((result) => {
          res.statusCode = result.status
          res.end(result.host ? JSON.stringify({ host: result.host }) : undefined)
        })
        return
      }
      calls.count++
      const url = new URL(req.url ?? "/", "http://cp")
      const sid = url.pathname.split("/").pop() ?? ""
      const admin = url.searchParams.get("admin") === "1"
      res.statusCode = live.has(sid) && (!admin || admins.has(sid)) ? 200 : 404
      res.end()
    }),
  )
  return { url: `http://127.0.0.1:${port}`, live, admins, hosts, wakes, calls, state }
}

async function upstream(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const seen: IncomingMessage[] = []
  const port = await listen(
    createServer((req, res) => {
      seen.push(req)
      handler(req, res)
    }),
  )
  return { host: `http://127.0.0.1:${port}`, seen }
}

async function nodeSetup() {
  const cp = await controlPlane()
  return { cp, base: `http://127.0.0.1:${await nodeRouter(cp.url)}` }
}

const built = { dir: undefined as Promise<string> | undefined }

/**
 * The router built and run under Node, as it runs in production: Bun's `node:http` neither passes WebSocket bytes
 * nor reports when a connection is made, which waking a paused VM relies on. Returns its port.
 */
async function nodeRouter(controlPlaneUrl: string) {
  built.dir ??= (async () => {
    const outdir = await mkdtemp(path.join(tmpdir(), "omai-router-"))
    const result = await Bun.build({
      entrypoints: [new URL("../src/main.ts", import.meta.url).pathname],
      target: "node",
      outdir,
    })
    if (!result.success) throw new Error("router build failed")
    return outdir
  })()
  const outdir = await built.dir
  const port = await freePort()
  const child = Bun.spawn(["node", path.join(outdir, "main.js")], {
    env: {
      PATH: process.env.PATH,
      OMAI_ROUTER_PORT: String(port),
      OMAI_TOKEN_PUBLIC_KEY: keys.publicKeyPem,
      OMAI_APP_ORIGIN: APP,
      OMAI_CONTROL_PLANE_URL: controlPlaneUrl,
    },
    stdout: "pipe",
  })
  cleanup.push(async () => {
    child.kill()
    await child.exited
  })
  await new Response(child.stdout).body!.getReader().read()
  return port
}

afterAll(async () => {
  if (built.dir) await rm(await built.dir, { recursive: true, force: true })
})

async function setup(cacheMs = 30_000) {
  const cp = await controlPlane()
  const router = await Router.start({
    port: 0,
    publicKey: keys.publicKeyPem,
    appOrigin: APP,
    controlPlaneUrl: cp.url,
    cacheMs,
  })
  cleanup.push(() => router.close())
  return { cp, base: `http://127.0.0.1:${router.port}` }
}

function token(host: string, claims: Partial<SignedToken.VmClaims> = {}) {
  return SignedToken.sign(
    { typ: "vm", sub: "u1", pid: "p1", sid: "s1", host, exp: Math.floor(Date.now() / 1000) + 60, ...claims },
    keys.privateKeyPem,
  )
}

function freePort() {
  return new Promise<number>((resolve) => {
    const server = createServer()
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      server.close(() => resolve(typeof address === "object" && address ? address.port : 0))
    })
  })
}

const basic = (value: string) => `Basic ${Buffer.from(`omai:${value}`).toString("base64")}`

describe("Router", () => {
  test("forwards to the host in the token", async () => {
    const up = await upstream((req, res) => res.end(`hello ${req.url}`))
    const s = await setup()
    const auth = basic(token(up.host))
    const res = await fetch(`${s.base}/vm/p1/api/info?x=1`, { headers: { authorization: auth, origin: APP } })
    expect(res.status).toBe(200)
    expect(await res.text()).toBe("hello /api/info?x=1")
    expect(up.seen[0]?.headers.authorization).toBe(auth)
    expect(res.headers.get("access-control-allow-origin")).toBe(APP)
  })

  test("forwards request bodies", async () => {
    const up = await upstream((req, res) => {
      const chunks: Buffer[] = []
      req.on("data", (c: Buffer) => chunks.push(c))
      req.on("end", () => res.end(`${req.method} ${Buffer.concat(chunks).toString()}`))
    })
    const s = await setup()
    const res = await fetch(`${s.base}/vm/p1/api/thing`, {
      method: "POST",
      headers: { authorization: basic(token(up.host)) },
      body: "payload",
    })
    expect(await res.text()).toBe("POST payload")
  })

  test("accepts the token in the auth_token query", async () => {
    const up = await upstream((_req, res) => res.end("ok"))
    const s = await setup()
    const query = Buffer.from(`omai:${token(up.host)}`).toString("base64")
    expect((await fetch(`${s.base}/vm/p1/api/event?auth_token=${encodeURIComponent(query)}`)).status).toBe(200)
  })

  test("streams SSE", async () => {
    const gate = Promise.withResolvers<void>()
    const up = await upstream((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" })
      res.write("data: one\n\n")
      void gate.promise.then(() => res.end("data: two\n\n"))
    })
    const s = await setup()
    const res = await fetch(`${s.base}/vm/p1/api/event`, { headers: { authorization: basic(token(up.host)) } })
    const reader = res.body!.getReader()
    const first = new TextDecoder().decode((await reader.read()).value)
    expect(first).toBe("data: one\n\n")
    gate.resolve()
    const rest = await new Response(
      new ReadableStream({
        start: async (c) => {
          for (;;) {
            const chunk = await reader.read()
            if (chunk.done) return c.close()
            c.enqueue(chunk.value)
          }
        },
      }),
    ).text()
    expect(rest).toBe("data: two\n\n")
  })

  // Bun's own node:http upgrade sockets do not carry raw bytes, and production runs the router on Node, so this
  // test builds the router and runs it under Node.
  test("proxies websockets", async () => {
    const ws = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (req, server) => (server.upgrade(req) ? undefined : new Response("no", { status: 400 })),
      websocket: {
        message: (socket, message) => {
          socket.send(`echo ${message}`)
        },
      },
    })
    cleanup.push(() => ws.stop(true))
    const cp = await controlPlane()
    const port = await nodeRouter(cp.url)
    const query = Buffer.from(`omai:${token(`http://127.0.0.1:${ws.port}`)}`).toString("base64")
    const socket = new WebSocket(`ws://127.0.0.1:${port}/vm/p1/pty?auth_token=${encodeURIComponent(query)}`)
    const reply = await new Promise<string>((resolve, reject) => {
      socket.onopen = () => socket.send("hi")
      socket.onmessage = (event) => resolve(String(event.data))
      socket.onerror = () => reject(new Error("websocket error"))
    })
    socket.close()
    expect(reply).toBe("echo hi")
    // Typing in a terminal is activity.
    await Bun.sleep(100)
    expect(cp.calls.activity).toContain("p1")
  })

  // A terminal opened with only a ticket is someone using the project once its server accepts the ticket, so typing
  // only in a terminal keeps the VM awake. A ticket the server turns down never counts.
  test("websockets on an accepted ticket are activity", async () => {
    const ws = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (req, server) =>
        new URL(req.url).searchParams.get("ticket") === "good" && server.upgrade(req)
          ? undefined
          : new Response("bad ticket", { status: 401 }),
      websocket: { message: (socket, message) => void socket.send(`echo ${message}`) },
    })
    cleanup.push(() => ws.stop(true))
    const cp = await controlPlane()
    cp.hosts.set("p1", `http://127.0.0.1:${ws.port}`)
    const port = await nodeRouter(cp.url)
    const path = "/api/experimental/persistent-pty/pty_1/connect"
    const rejected = await new Promise<string>((resolve) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/vm/p1${path}?ticket=bad`)
      socket.onerror = () => resolve("refused")
      socket.onopen = () => resolve("open")
    })
    expect(rejected).toBe("refused")
    await Bun.sleep(100)
    expect(cp.calls.activity).toEqual([])
    const socket = new WebSocket(`ws://127.0.0.1:${port}/vm/p1${path}?ticket=good`)
    const reply = await new Promise<string>((resolve, reject) => {
      socket.onopen = () => socket.send("ls")
      socket.onmessage = (event) => resolve(String(event.data))
      socket.onerror = () => reject(new Error("websocket error"))
    })
    socket.close()
    expect(reply).toBe("echo ls")
    await Bun.sleep(100)
    expect(cp.calls.activity).toContain("p1")
  })

  test("preflight without token", async () => {
    const s = await setup()
    const ok = await fetch(`${s.base}/vm/p1/api/session`, {
      method: "OPTIONS",
      headers: {
        origin: APP,
        "access-control-request-method": "POST",
        "access-control-request-headers": "authorization, content-type, x-custom",
      },
    })
    expect(ok.status).toBe(204)
    expect(ok.headers.get("access-control-allow-origin")).toBe(APP)
    expect(ok.headers.get("access-control-allow-headers")).toContain("authorization")
    const foreign = await fetch(`${s.base}/vm/p1/api/session`, {
      method: "OPTIONS",
      headers: { origin: "http://evil.test" },
    })
    expect(foreign.status).toBe(403)
  })

  test("token for another project is 404", async () => {
    const up = await upstream((_req, res) => res.end("ok"))
    const s = await setup()
    const res = await fetch(`${s.base}/vm/p2/api/info`, {
      headers: { authorization: basic(token(up.host)), origin: APP },
    })
    expect(res.status).toBe(404)
    expect(res.headers.get("access-control-allow-origin")).toBe(APP)
    expect(up.seen).toHaveLength(0)
  })

  test("bad or missing token is 404", async () => {
    const up = await upstream((_req, res) => res.end("ok"))
    const s = await setup()
    expect((await fetch(`${s.base}/vm/p1/api/info`)).status).toBe(404)
    expect((await fetch(`${s.base}/vm/p1/api/info`, { headers: { authorization: basic("garbage") } })).status).toBe(404)
    const other = SignedToken.generateKeyPair()
    const forged = SignedToken.sign(
      { typ: "vm", sub: "u1", pid: "p1", sid: "s1", host: up.host, exp: Math.floor(Date.now() / 1000) + 60 },
      other.privateKeyPem,
    )
    expect((await fetch(`${s.base}/vm/p1/api/info`, { headers: { authorization: basic(forged) } })).status).toBe(404)
    expect((await fetch(`${s.base}/other`)).status).toBe(404)
    expect(up.seen).toHaveLength(0)
  })

  test("ended session is refused within the cache window", async () => {
    const up = await upstream((_req, res) => res.end("ok"))
    const s = await setup(50)
    const headers = { authorization: basic(token(up.host)) }
    expect((await fetch(`${s.base}/vm/p1/api/info`, { headers })).status).toBe(200)
    expect((await fetch(`${s.base}/vm/p1/api/info`, { headers })).status).toBe(200)
    expect(s.cp.calls.count).toBe(1)
    s.cp.live.delete("s1")
    await Bun.sleep(60)
    expect((await fetch(`${s.base}/vm/p1/api/info`, { headers })).status).toBe(401)
  })

  test("a VM that can't be woken answers 503", async () => {
    const s = await nodeSetup()
    const res = await fetch(`${s.base}/vm/p1/api/session`, {
      method: "POST",
      headers: { authorization: basic(token("http://127.0.0.1:1")) },
    })
    expect(res.status).toBe(503)
    expect(s.cp.calls.wakes).toBe(1)
  })

  // An open app keeps polling every project it opened; those reads must not wake VMs the user has left.
  test("a read to a paused VM answers 503 without waking it", async () => {
    const s = await nodeSetup()
    const res = await fetch(`${s.base}/vm/p1/api/info`, {
      headers: { authorization: basic(token("http://127.0.0.1:1")) },
    })
    expect(res.status).toBe(503)
    expect(s.cp.calls.wakes).toBe(0)
  })

  test("wakes a paused VM and retries", async () => {
    const port = await freePort()
    const host = `http://127.0.0.1:${port}`
    const s = await nodeSetup()
    s.cp.wakes.set("p1", async () => {
      // The VM comes back on the same address, as the control plane guarantees.
      const server = createServer((req, res) => {
        const chunks: Buffer[] = []
        req.on("data", (c: Buffer) => chunks.push(c))
        req.on("end", () => res.end(`woke ${req.method} ${Buffer.concat(chunks).toString()}`))
      })
      await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve))
      cleanup.push(() => new Promise<void>((done) => server.close(() => done())))
      cleanup.push(() => server.closeAllConnections())
      return { status: 200, host }
    })
    const send = () =>
      fetch(`${s.base}/vm/p1/api/thing`, {
        method: "POST",
        headers: { authorization: basic(token(host)) },
        body: "payload",
      })
    const [first, second] = await Promise.all([send(), send()])
    expect(await first.text()).toBe("woke POST payload")
    expect(await second.text()).toBe("woke POST payload")
    expect(s.cp.calls.wakes).toBe(1)
  })

  test("a woken VM at another address is refused", async () => {
    const elsewhere = await upstream((_req, res) => res.end("wrong"))
    const s = await nodeSetup()
    s.cp.wakes.set("p1", async () => ({ status: 200, host: elsewhere.host }))
    const res = await fetch(`${s.base}/vm/p1/api/session`, {
      method: "POST",
      headers: { authorization: basic(token("http://127.0.0.1:1")) },
    })
    expect(res.status).toBe(404)
    expect(elsewhere.seen).toHaveLength(0)
  })

  test("reports activity once per 15 s, not for reads or heartbeats", async () => {
    const up = await upstream((_req, res) => res.end("ok"))
    const s = await setup()
    const headers = { authorization: basic(token(up.host)) }
    // What an open but untouched app keeps sending: health checks, refreshes and the preview's heartbeat.
    await fetch(`${s.base}/vm/p1/api/event`, { headers })
    await fetch(`${s.base}/vm/p1/api/info`, { headers })
    await fetch(`${s.base}/vm/p1/api/session`, { headers })
    await fetch(`${s.base}/vm/p1/api/rpc/omai.preview/watch`, { method: "POST", headers })
    await Bun.sleep(50)
    expect(s.cp.calls.activity).toEqual([])
    await fetch(`${s.base}/vm/p1/api/session`, { method: "POST", headers, body: "{}" })
    await fetch(`${s.base}/vm/p1/api/session/x/message`, { method: "POST", headers, body: "{}" })
    await Bun.sleep(50)
    expect(s.cp.calls.activity).toEqual(["p1"])
  })

  // Browsers cannot send a header on a WebSocket, so the terminal connects with only a one-time ticket in its address,
  // which the project's server checks itself. The router lets exactly those addresses through, as that server does.
  test("terminal ticket addresses reach the project without a token", async () => {
    const up = await upstream((req, res) => res.end(`reached ${req.url}`))
    const s = await setup()
    s.cp.hosts.set("p1", up.host)
    const path = "/api/experimental/persistent-pty/pty_1/connect?ticket=abc&cursor=0"
    const res = await fetch(`${s.base}/vm/p1${path}`)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe(`reached ${path}`)
    expect((await fetch(`${s.base}/vm/p1/api/pty/pty_1/connect?ticket=abc`)).status).toBe(200)
    expect((await fetch(`${s.base}/vm/p1/api/experimental/client-mcp?ticket=abc&name=x`)).status).toBe(200)
    // Only the project's server checks the ticket, so these never count as someone using the project.
    await Bun.sleep(50)
    expect(s.cp.calls.activity).toEqual([])
  })

  // A terminal reconnecting to a VM that was paused gets through as soon as the VM runs again, not after a cache window.
  test("a ticket reaches a project as soon as its VM is back", async () => {
    const up = await upstream((req, res) => res.end(`reached ${req.url}`))
    const s = await setup()
    const path = "/api/experimental/persistent-pty/pty_1/connect?ticket=abc"
    expect((await fetch(`${s.base}/vm/p1${path}`)).status).toBe(404)
    s.cp.hosts.set("p1", up.host)
    const res = await fetch(`${s.base}/vm/p1${path}`)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe(`reached ${path}`)
  })

  test("a ticket on any other address still needs a token", async () => {
    const up = await upstream((_req, res) => res.end("ok"))
    const s = await setup()
    s.cp.hosts.set("p1", up.host)
    expect((await fetch(`${s.base}/vm/p1/api/session?ticket=abc`)).status).toBe(404)
    expect((await fetch(`${s.base}/vm/p1/api/experimental/persistent-pty/pty_1/connect`)).status).toBe(404)
    expect(up.seen).toHaveLength(0)
    expect(s.cp.calls.hosts).toBe(0)
  })

  test("a ticket for an unknown project is 404", async () => {
    const s = await setup()
    expect((await fetch(`${s.base}/vm/nope/api/experimental/persistent-pty/pty_1/connect?ticket=abc`)).status).toBe(404)
  })

  test("the ticket addresses match the server's own rules", () => {
    const urls = [
      "/api/pty/a/connect?ticket=t",
      "/api/experimental/persistent-pty/a/connect?ticket=t",
      "/api/experimental/client-mcp?ticket=t",
      "/api/pty/a/connect",
      "/api/pty/a/b/connect?ticket=t",
      "/api/session?ticket=t",
      "/api/experimental/client-mcp/x?ticket=t",
    ].map((path) => new URL(path, "http://vm"))
    const server = urls.map(
      (url) => hasPtyConnectTicketURL(url) || hasPersistentPtyConnectTicketURL(url) || hasMcpClientTicketURL(url),
    )
    expect(urls.map((url) => Router.ticketPath(url))).toEqual(server)
  })

  // Admins reach the platform server for Settings > Providers and Models only: never its sessions, shell or files.
  test("the platform server passes only settings routes, and never counts as activity", async () => {
    const up = await upstream((req, res) => res.end(`reached ${req.url}`))
    const s = await setup()
    const headers = { authorization: basic(token(up.host, { pid: "platform" })) }
    for (const path of [
      "/api/info",
      "/api/provider",
      "/api/integration/openai",
      "/api/credential",
      "/api/model",
      "/api/location",
      "/api/project",
      "/api/session/active",
      "/api/vcs",
    ])
      expect((await fetch(`${s.base}/vm/platform${path}`, { headers })).status).toBe(200)
    // Reads the app needs to load; never writes there.
    for (const path of ["/api/project", "/api/session/active", "/api/location"])
      expect((await fetch(`${s.base}/vm/platform${path}`, { method: "POST", headers })).status).toBe(404)
    for (const path of [
      "/api/session",
      "/api/shell",
      "/api/pty",
      "/api/experimental/persistent-pty/x/connect?ticket=t",
      "/api/file?path=/etc/passwd",
      "/api/fs/list",
      "/api/experimental/platform/providers",
    ])
      expect((await fetch(`${s.base}/vm/platform${path}`, { method: "POST", headers })).status).toBe(404)
    await Bun.sleep(50)
    expect(s.cp.calls.activity).toEqual([])
  })

  test("the platform server needs a session that is still an admin's", async () => {
    const up = await upstream((_req, res) => res.end("ok"))
    const s = await setup(50)
    const headers = { authorization: basic(token(up.host, { pid: "platform" })) }
    expect((await fetch(`${s.base}/vm/platform/api/provider`, { headers })).status).toBe(200)
    s.cp.admins.delete("s1")
    await Bun.sleep(60)
    expect((await fetch(`${s.base}/vm/platform/api/provider`, { headers })).status).toBe(401)
    // A project of the same session is unaffected.
    expect(
      (await fetch(`${s.base}/vm/p1/api/info`, { headers: { authorization: basic(token(up.host)) } })).status,
    ).toBe(200)
  })

  test("the platform server ignores a requested directory", async () => {
    const up = await upstream((req, res) =>
      res.end(JSON.stringify({ url: req.url, dir: req.headers["x-omai-directory"] ?? null })),
    )
    const s = await setup()
    const headers = { authorization: basic(token(up.host, { pid: "platform" })), "x-omai-directory": "/somewhere/else" }
    const res = await fetch(`${s.base}/vm/platform/api/provider?location%5Bdirectory%5D=%2Fsomewhere&a=1`, { headers })
    expect(await res.json()).toEqual({ url: "/api/provider?a=1", dir: null })
  })

  test("a session already seen live keeps working while the control plane is unreachable", async () => {
    const up = await upstream((_req, res) => res.end("ok"))
    const s = await setup(50)
    const headers = { authorization: basic(token(up.host)) }
    const other = { authorization: basic(token(up.host, { sid: "s2" })) }
    s.cp.live.add("s2")
    expect((await fetch(`${s.base}/vm/p1/api/info`, { headers })).status).toBe(200)
    s.cp.state.down = true
    await Bun.sleep(60)
    expect((await fetch(`${s.base}/vm/p1/api/info`, { headers })).status).toBe(200)
    // A session the router never saw live can't be vouched for.
    expect((await fetch(`${s.base}/vm/p1/api/info`, { headers: other })).status).toBe(401)
    // Back up and the session ended: refused again.
    s.cp.state.down = false
    s.cp.live.delete("s1")
    await Bun.sleep(60)
    expect((await fetch(`${s.base}/vm/p1/api/info`, { headers })).status).toBe(401)
  })

  test("no outage grace for the platform server's admin check", async () => {
    const up = await upstream((_req, res) => res.end("ok"))
    const s = await setup(50)
    const headers = { authorization: basic(token(up.host, { pid: "platform" })) }
    expect((await fetch(`${s.base}/vm/platform/api/provider`, { headers })).status).toBe(200)
    s.cp.state.down = true
    await Bun.sleep(60)
    expect((await fetch(`${s.base}/vm/platform/api/provider`, { headers })).status).toBe(401)
  })

  test("the outage grace ends 5 minutes after the last confirmation", async () => {
    const up = await upstream((_req, res) => res.end("ok"))
    const cp = await controlPlane()
    const clock = { now: Date.now() }
    const router = await Router.start({
      port: 0,
      publicKey: keys.publicKeyPem,
      appOrigin: APP,
      controlPlaneUrl: cp.url,
      cacheMs: 50,
      now: () => clock.now,
    })
    cleanup.push(() => router.close())
    const base = `http://127.0.0.1:${router.port}`
    const headers = { authorization: basic(token(up.host)) }
    expect((await fetch(`${base}/vm/p1/api/info`, { headers })).status).toBe(200)
    cp.state.down = true
    clock.now += 4 * 60_000
    expect((await fetch(`${base}/vm/p1/api/info`, { headers })).status).toBe(200)
    clock.now += 2 * 60_000
    expect((await fetch(`${base}/vm/p1/api/info`, { headers })).status).toBe(401)
  })
})
