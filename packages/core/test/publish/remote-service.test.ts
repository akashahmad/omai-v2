import { afterAll, beforeAll, describe, expect } from "bun:test"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { Effect, Layer } from "effect"
import yauzl from "yauzl"
import { Database } from "@opencode/core/database/database"
import { PublishDomains } from "@opencode/core/publish/domains"
import { PublishService } from "@opencode/core/publish/service"
import { Global } from "@opencode/util/global"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { tmpdir } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"

// A project VM: the control plane does every Cloudflare call, and no Cloudflare variable is set here.

type Request = { method: string; route: string; query: URLSearchParams; body: Buffer; auth?: string }
const cp = {
  requests: [] as Request[],
  site: undefined as undefined | { name: string; url: string; zone: string; kind?: string; publishedAt?: number },
  /** When set, every request's connection is dropped, as when the control plane is down. */
  down: false,
  /** When set, a deploy is never answered. */
  hang: false,
  domains: { configured: true, domains: [] as unknown[] },
}

const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  if (cp.down) return req.socket.destroy()
  const url = new URL(req.url ?? "/", "http://cp")
  const route = url.pathname.replace(/^\/internal\/projects\/prj_vm/, "")
  if (route === "/publish/deploy" && cp.hang) {
    cp.requests.push({ method: req.method ?? "", route, query: url.searchParams, body: Buffer.alloc(0) })
    req.resume()
    return
  }
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  const body = Buffer.concat(chunks)
  cp.requests.push({ method: req.method ?? "", route, query: url.searchParams, body, auth: req.headers.authorization })
  const json = (status: number, value?: unknown) => {
    res.writeHead(status, { "content-type": "application/json" })
    res.end(value === undefined ? "" : JSON.stringify(value))
  }
  const key = `${req.method} ${route}`
  if (key === "GET /publish") return json(200, { configured: true, zone: "omai.test", ...(cp.site ? { site: cp.site } : {}) })
  if (key === "POST /publish/available") return json(200, { available: true })
  if (key === "POST /publish/claim") {
    const name = JSON.parse(body.toString()).name
    cp.site = { name, url: `https://${name}.omai.test`, zone: "omai.test" }
    return json(200, cp.site)
  }
  if (key === "POST /publish/release") {
    if (cp.site && !cp.site.publishedAt) cp.site = undefined
    return json(204)
  }
  if (key === "POST /publish/deploy") {
    cp.site = { ...cp.site!, kind: url.searchParams.get("kind")!, publishedAt: Date.now() }
    return json(200, { log: "uploaded by the control plane\n" })
  }
  if (key === "GET /domains") return json(200, cp.domains)
  if (key === "POST /domains") return json(200, cp.domains)
  return json(404)
})

const saved = { ...process.env }
let root: Awaited<ReturnType<typeof tmpdir>>
const paths = { data: "" }

beforeAll(async () => {
  root = await tmpdir("omai-publish-vm-")
  paths.data = path.join(root.path, "data")
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  for (const key of Object.keys(process.env)) if (key.startsWith("OMAI_CLOUDFLARE_")) delete process.env[key]
  Object.assign(process.env, {
    OMAI_CONTROL_PLANE_URL: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    OMAI_PROJECT_ID: "prj_vm",
    OMAI_PROJECT_TOKEN: "vm-token",
  })
})

afterAll(async () => {
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]
  Object.assign(process.env, saved)
  server.closeAllConnections()
  server.close()
  await root[Symbol.asyncDispose]()
})

const it = testEffect(
  LayerNode.compile(LayerNode.group([PublishService.node, PublishDomains.node, Database.node]), {
    replacements: [Global.node.replace(Layer.unwrap(Effect.sync(() => Global.layerWith({ data: paths.data }))))],
  }),
)

async function project(files: Record<string, string>) {
  const dir = path.join(root.path, "projects", randomUUID())
  await Promise.all(
    Object.entries(files).map(async (entry) => {
      await mkdir(path.dirname(path.join(dir, entry[0])), { recursive: true })
      await writeFile(path.join(dir, entry[0]), entry[1])
    }),
  )
  return dir
}

const staticSite = () => project({ "index.html": "<h1>hi</h1>", ".env": "SECRET=1", "assets/app.css": "body{}" })

const settle = Effect.fnUntraced(function* (projectID: string, directory: string) {
  const service = yield* PublishService.Service
  for (let index = 0; index < 400; index++) {
    const status = yield* service.status(projectID, directory)
    if (!status.running) return status
    yield* Effect.sleep("50 millis")
  }
  throw new Error("the publish did not finish")
})

async function zipNames(data: Buffer) {
  const names: string[] = []
  await new Promise<void>((resolve, reject) =>
    yauzl.fromBuffer(data, { lazyEntries: true }, (error, file) => {
      if (error || !file) return reject(error)
      file.on("entry", (entry: yauzl.Entry) => {
        names.push(entry.fileName)
        file.readEntry()
      })
      file.on("end", () => resolve())
      file.readEntry()
    }),
  )
  return names.filter((name) => !name.endsWith("/")).sort()
}

const reset = () => {
  cp.requests = []
  cp.site = undefined
  cp.down = false
  cp.hang = false
}

describe("PublishService on a project VM", () => {
  it.live("status comes from the control plane", () =>
    Effect.gen(function* () {
      reset()
      cp.site = { name: "vm-site", url: "https://vm-site.omai.test", zone: "omai.test", kind: "static", publishedAt: 1 }
      const service = yield* PublishService.Service
      const status = yield* service.status("prj_vm", yield* Effect.promise(staticSite))
      expect(status.configured).toBe(true)
      expect(status.zone).toBe("omai.test")
      expect(status.site).toMatchObject({ name: "vm-site", kind: "static", publishedAt: 1 })
      expect(cp.requests[0]).toMatchObject({ method: "GET", route: "/publish", auth: "Bearer vm-token" })
    }),
  )

  it.live(
    "a publish uploads the bundle and records it live",
    () =>
      Effect.gen(function* () {
        reset()
        const service = yield* PublishService.Service
        const directory = yield* Effect.promise(staticSite)
        expect(yield* service.available("prj_vm", "vm-new")).toEqual({ available: true })
        const deploy = yield* service.publish({ projectID: "prj_vm", directory, name: "vm-new" })
        const status = yield* settle("prj_vm", directory)
        expect(status.history[0]).toMatchObject({ id: deploy.id, status: "live", kind: "static" })
        expect(status.site).toMatchObject({ name: "vm-new", kind: "static" })
        const upload = cp.requests.find((request) => request.route === "/publish/deploy")!
        expect(upload.query.get("kind")).toBe("static")
        expect(yield* Effect.promise(() => zipNames(upload.body))).toEqual([
          "bundle/assets/assets/app.css",
          "bundle/assets/index.html",
        ])
        expect(cp.requests.map((request) => request.route)).toContain("/publish/claim")
        expect(yield* service.log("prj_vm", deploy.id)).toContain("uploaded by the control plane")
      }),
    30_000,
  )

  it.live(
    "a failed build releases the claimed name",
    () =>
      Effect.gen(function* () {
        reset()
        const service = yield* PublishService.Service
        const directory = yield* Effect.promise(() =>
          project({
            "package.json": JSON.stringify({ name: "f", private: true, scripts: { dev: "vite", build: "exit 3" } }),
            "vite.config.js": "export default {}\n",
          }),
        )
        yield* service.publish({ projectID: "prj_vm", directory, name: "vm-broken" })
        const status = yield* settle("prj_vm", directory)
        expect(status.history[0]?.status).toBe("failed")
        expect(cp.requests.map((request) => request.route)).toContain("/publish/release")
        expect(cp.requests.map((request) => request.route)).not.toContain("/publish/deploy")
        expect(cp.site).toBeUndefined()
      }),
    120_000,
  )

  it.live(
    "an unreachable control plane fails the deploy and keeps the last status",
    () =>
      Effect.gen(function* () {
        reset()
        cp.site = { name: "vm-live", url: "https://vm-live.omai.test", zone: "omai.test", kind: "static", publishedAt: 1 }
        const service = yield* PublishService.Service
        const directory = yield* Effect.promise(staticSite)
        expect((yield* service.status("prj_vm", directory)).site?.name).toBe("vm-live")
        cp.down = true
        yield* service.publish({ projectID: "prj_vm", directory })
        const status = yield* settle("prj_vm", directory)
        expect(status.history[0]?.status).toBe("failed")
        expect(status.history[0]?.error).toBe("Couldn't reach O M A I +. Try again in a moment.")
        expect(status.site?.name).toBe("vm-live")
        expect(status.configured).toBe(true)
      }),
    30_000,
  )

  it.live(
    "cancel aborts the upload",
    () =>
      Effect.gen(function* () {
        reset()
        cp.site = { name: "vm-cancel", url: "https://vm-cancel.omai.test", zone: "omai.test", kind: "static", publishedAt: 1 }
        cp.hang = true
        const service = yield* PublishService.Service
        const directory = yield* Effect.promise(staticSite)
        yield* service.publish({ projectID: "prj_vm", directory })
        for (let index = 0; index < 200 && !cp.requests.some((request) => request.route === "/publish/deploy"); index++)
          yield* Effect.sleep("50 millis")
        const started = Date.now()
        yield* service.cancel("prj_vm")
        const status = yield* settle("prj_vm", directory)
        expect(status.history[0]?.status).toBe("cancelled")
        // The aborted upload ends the deploy at once. Under Node (the built server) the abort also closes the
        // connection, which stops wrangler on the control plane; Bun's fetch leaves it open, so that part is covered
        // by the control plane's own cancel test.
        expect(Date.now() - started).toBeLessThan(2_000)
      }),
    30_000,
  )

  it.live("domains are forwarded", () =>
    Effect.gen(function* () {
      reset()
      cp.domains = { configured: true, domains: [] }
      const domains = yield* PublishDomains.Service
      expect(yield* domains.list("prj_vm")).toEqual({ configured: true, domains: [] })
      yield* domains.add("prj_vm", "www.vm.edu", true)
      expect(cp.requests.at(-1)).toMatchObject({ method: "POST", route: "/domains" })
      expect(JSON.parse(cp.requests.at(-1)!.body.toString())).toEqual({ hostname: "www.vm.edu", primary: true })
    }),
  )
})
