import { afterEach, describe, expect, test } from "bun:test"
import { createServer, request, type IncomingHttpHeaders, type RequestListener } from "node:http"
import { connect, type Socket } from "node:net"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { gzipSync } from "node:zlib"
import { openProxy, type Proxy, type Upstream } from "@opencode/core/preview/proxy"

const closers: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()))
})

async function upstream(handler: RequestListener) {
  const server = createServer(handler)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  // Upgraded sockets keep a server open, so the test closes them along with it.
  const sockets = new Set<Socket>()
  server.on("connection", (socket) => sockets.add(socket))
  closers.push(
    () =>
      new Promise((resolve) => {
        sockets.forEach((socket) => socket.destroy())
        server.close(() => resolve())
      }),
  )
  const address = server.address()
  return { server, port: typeof address === "object" && address ? address.port : 0 }
}

type Options = {
  upstream: () => Upstream
  auth?: Parameters<typeof openProxy>[0]["auth"]
  uploads?: Parameters<typeof openProxy>[0]["uploads"]
}

async function proxy(options: Options): Promise<Proxy> {
  const opened = await openProxy({
    hostname: "127.0.0.1",
    port: 0,
    upstream: options.upstream,
    auth: options.auth,
    bridge: (parent) => `/* bridge for ${parent} */`,
    visual: (parent) => `/* visual editor for ${parent} */`,
    uploads: options.uploads ?? (() => undefined),
    events: { subscribe: () => () => {} },
  })
  closers.push(opened.close)
  return opened
}

function get(port: number, path: string, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; headers: IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, headers }, (res) => {
      const chunks: Buffer[] = []
      res.on("data", (chunk: Buffer) => chunks.push(chunk))
      res.on("end", () =>
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString() }),
      )
    })
    req.on("error", reject)
    req.end()
  })
}

const html =
  (body: string): RequestListener =>
  (_, res) => {
    res.setHeader("content-type", "text/html; charset=utf-8")
    res.end(body)
  }

describe("proxy", () => {
  test("serves the visual editor script with no-store", async () => {
    const opened = await proxy({ upstream: () => ({ kind: "down" }) })
    const res = await get(opened.port, "/__omai/visual.js", {
      cookie: `omai_parent=${encodeURIComponent("http://localhost:4096")}`,
    })

    expect(res.status).toBe(200)
    expect(String(res.headers["content-type"])).toContain("text/javascript")
    expect(res.headers["cache-control"]).toBe("no-store")
    expect(res.body).toBe("/* visual editor for http://localhost:4096 */")
  })

  // A dev server may not serve a file added to public/ after it started; the preview shows the upload anyway.
  test("serves an uploaded image itself, before the dev server knows it", async () => {
    const folder = await mkdtemp(path.join(tmpdir(), "omai-uploads-"))
    await writeFile(path.join(folder, "new.png"), "png bytes")
    const app = await upstream((_, res) => {
      res.statusCode = 404
      res.end("not found")
    })
    const opened = await proxy({
      upstream: () => ({ kind: "port", port: app.port }),
      uploads: (pathname) => (pathname === "/images/new.png" ? path.join(folder, "new.png") : undefined),
    })
    const image = await get(opened.port, "/images/new.png")
    const other = await get(opened.port, "/images/other.png")

    expect(image.status).toBe(200)
    expect(String(image.headers["content-type"])).toBe("image/png")
    expect(image.body).toBe("png bytes")
    expect(other.status).toBe(404)
  })

  test("an upload that is gone again falls through to the dev server", async () => {
    const app = await upstream((_, res) => res.end("from the app"))
    const opened = await proxy({
      upstream: () => ({ kind: "port", port: app.port }),
      uploads: () => path.join(tmpdir(), "omai-missing-upload.png"),
    })

    expect((await get(opened.port, "/images/new.png")).body).toBe("from the app")
  })

  test("rewrites Host and Origin for the upstream", async () => {
    let seen: IncomingHttpHeaders = {}
    const app = await upstream((req, res) => {
      seen = req.headers
      res.end("ok")
    })
    const opened = await proxy({ upstream: () => ({ kind: "port", port: app.port }) })
    await get(opened.port, "/", { origin: `http://127.0.0.1:${opened.port}` })

    expect(seen.host).toBe(`127.0.0.1:${app.port}`)
    expect(seen.origin).toBe(`http://127.0.0.1:${app.port}`)
  })

  test("injects the bridge right after <head>", async () => {
    const app = await upstream(html("<html><head><title>x</title></head><body></body></html>"))
    const opened = await proxy({ upstream: () => ({ kind: "port", port: app.port }) })
    const res = await get(opened.port, "/", { accept: "text/html" })

    expect(res.body).toBe(
      '<html><head><script src="/__omai/bridge.js"></script><title>x</title></head><body></body></html>',
    )
    expect(Number(res.headers["content-length"] ?? Buffer.byteLength(res.body))).toBe(Buffer.byteLength(res.body))
  })

  test("injects into html without a head", async () => {
    const app = await upstream(html("<p>hi</p>"))
    const opened = await proxy({ upstream: () => ({ kind: "port", port: app.port }) })

    expect((await get(opened.port, "/")).body).toStartWith('<script src="/__omai/bridge.js"></script><p>hi</p>')
  })

  test("leaves other responses untouched", async () => {
    const script = "export const a = 1\n"
    const app = await upstream((_, res) => {
      res.setHeader("content-type", "text/javascript")
      res.setHeader("content-length", String(Buffer.byteLength(script)))
      res.end(script)
    })
    const opened = await proxy({ upstream: () => ({ kind: "port", port: app.port }) })
    const res = await get(opened.port, "/main.js")

    expect(res.body).toBe(script)
    expect(res.headers["content-length"]).toBe(String(Buffer.byteLength(script)))
  })

  test("handles an upstream that gzips html anyway", async () => {
    const app = await upstream((_, res) => {
      res.setHeader("content-type", "text/html")
      res.setHeader("content-encoding", "gzip")
      res.end(gzipSync("<html><head></head></html>"))
    })
    const opened = await proxy({ upstream: () => ({ kind: "port", port: app.port }) })
    const res = await get(opened.port, "/")

    expect(res.body).toBe('<html><head><script src="/__omai/bridge.js"></script></head></html>')
    expect(res.headers["content-encoding"]).toBeUndefined()
  })

  test("strips frame blockers", async () => {
    const app = await upstream((_, res) => {
      res.setHeader("x-frame-options", "DENY")
      res.setHeader("content-security-policy", "frame-ancestors 'none'; script-src 'self'")
      res.end("ok")
    })
    const opened = await proxy({ upstream: () => ({ kind: "port", port: app.port }) })
    const res = await get(opened.port, "/")

    expect(res.headers["x-frame-options"]).toBeUndefined()
    expect(res.headers["content-security-policy"]).toBe("script-src 'self'")
  })

  test("pipes websocket upgrades", async () => {
    let host = ""
    const app = await upstream((_, res) => res.end())
    app.server.on("upgrade", (req, socket) => {
      host = req.headers.host ?? ""
      socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n")
      socket.on("data", (data) => socket.write(data))
    })
    const opened = await proxy({ upstream: () => ({ kind: "port", port: app.port }) })
    const echoed = await new Promise<string>((resolve) => {
      const socket = connect(opened.port, "127.0.0.1", () =>
        socket.write(
          `GET /hmr HTTP/1.1\r\nHost: 127.0.0.1:${opened.port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n`,
        ),
      )
      let buffer = ""
      socket.on("data", (data) => {
        buffer += data.toString()

        if (buffer.includes("\r\n\r\n") && !buffer.includes("ping")) socket.write("ping")

        if (buffer.includes("ping")) {
          socket.destroy()
          resolve(buffer)
        }
      })
    })

    expect(echoed).toStartWith("HTTP/1.1 101")
    expect(echoed).toContain("ping")
    expect(host).toBe(`127.0.0.1:${app.port}`)
  })

  test("serves the starting page while down", async () => {
    const opened = await proxy({ upstream: () => ({ kind: "down" }) })
    const res = await get(opened.port, "/", { accept: "text/html" })

    expect(res.status).toBe(200)
    expect(res.body).toContain("/__omai/events")
    // The pulsing brand icon, not a dots loader.
    expect(res.body).toContain('src="/__omai/logo"')
    expect(res.body).not.toContain('class="dot"')
  })

  test("a dead port becomes the starting page", async () => {
    const app = await upstream((_, res) => res.end())
    const port = app.port
    await new Promise((resolve) => app.server.close(resolve))
    const opened = await proxy({ upstream: () => ({ kind: "port", port }) })
    const res = await get(opened.port, "/", { accept: "text/html" })

    expect(res.status).toBe(200)
    expect(res.headers["x-omai-starting"]).toBe("1")
  })

  test("serves the bridge script for the entered parent", async () => {
    const opened = await proxy({ upstream: () => ({ kind: "down" }) })
    const entered = await get(opened.port, "/__omai/enter?parent=http%3A%2F%2Flocalhost%3A4096&to=%2Fabout")
    const cookie = String(entered.headers["set-cookie"]?.[0] ?? "").split(";")[0]!
    const res = await get(opened.port, "/__omai/bridge.js", { cookie })

    expect(entered.status).toBe(302)
    expect(entered.headers.location).toBe("/about")
    expect(res.headers["content-type"]).toContain("javascript")
    expect(res.body).toBe("/* bridge for http://localhost:4096 */")
  })

  test("the logo comes from the app that entered the preview", async () => {
    const opened = await proxy({ upstream: () => ({ kind: "down" }) })
    const entered = await get(opened.port, "/__omai/enter?parent=http%3A%2F%2Flocalhost%3A4096&to=%2F")
    const cookie = String(entered.headers["set-cookie"]?.[0] ?? "").split(";")[0]!
    const res = await get(opened.port, "/__omai/logo", { cookie })

    expect(res.status).toBe(302)
    expect(res.headers.location).toBe("http://localhost:4096/web-app-manifest-192x192.png")
  })

  test("auth", async () => {
    const app = await upstream((_, res) => res.end("secret"))
    const opened = await proxy({
      upstream: () => ({ kind: "port", port: app.port }),
      auth: { verify: (value) => value === "pass", exchange: (ticket) => (ticket === "good" ? "pass" : undefined) },
    })
    const denied = await get(opened.port, "/")
    const bad = await get(opened.port, "/__omai/enter?ticket=bad&to=%2F")
    const entered = await get(opened.port, "/__omai/enter?ticket=good&to=%2Fx")
    const cookies = (entered.headers["set-cookie"] ?? []).map((value) => value.split(";")[0]).join("; ")
    const allowed = await get(opened.port, "/", { cookie: cookies })

    expect(denied.status).toBe(401)
    expect(bad.status).toBe(401)
    expect(entered.status).toBe(302)
    expect(entered.headers["set-cookie"]?.join("\n")).toContain("HttpOnly")
    expect(entered.headers["set-cookie"]?.join("\n")).toContain("SameSite=Lax")
    expect(allowed.body).toBe("secret")
  })
})
