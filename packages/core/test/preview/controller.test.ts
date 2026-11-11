import { afterEach, describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { request } from "node:http"
import { tmpdir } from "node:os"
import path from "node:path"
import type { Preview } from "@opencode/schema/preview"
import { createController, devEnv, type Controller, type ControllerInput } from "@opencode/core/preview/controller"

const fixtures = path.join(import.meta.dir, "fixtures")
const fakeServer = path.join(fixtures, "fake-server.mjs")
const realNpm = Bun.which("npm") ?? "npm"
const controllers: Controller[] = []

afterEach(async () => {
  await Promise.all(controllers.splice(0).map((controller) => controller.close()))
})

// A project whose dev script is the fake server, with an `npm` on PATH whose installs are the fake package manager.
async function project(files: Record<string, string> = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "omai-preview-"))
  const bin = path.join(directory, ".bin-shim")
  await mkdir(bin)
  await writeFile(
    path.join(bin, "npm"),
    `#!/bin/sh\nif [ "$1" = "install" ]; then exec node ${JSON.stringify(path.join(fixtures, "fake-pm.mjs"))}; fi\nexec ${JSON.stringify(realNpm)} "$@"\n`,
  )
  await chmod(path.join(bin, "npm"), 0o755)
  const all = {
    "package.json": JSON.stringify({ name: "app", scripts: { dev: `node ${JSON.stringify(fakeServer)}` } }),
    ...files,
  }
  await Promise.all(
    Object.entries(all).map(async ([file, body]) => {
      await mkdir(path.dirname(path.join(directory, file)), { recursive: true })
      await writeFile(path.join(directory, file), body)
    }),
  )
  return { directory, path: `${bin}:${process.env.PATH}` }
}

function memoryStore(initial: Record<string, unknown> = {}) {
  const values = new Map(Object.entries(initial))
  return {
    values,
    get: async (key: string) => values.get(key),
    set: async (key: string, value: unknown) => {
      if (value === undefined) values.delete(key)
      else values.set(key, value)
    },
  }
}

function start(input: {
  directory: string
  path: string
  mode?: string
  store?: ReturnType<typeof memoryStore>
  config?: Preview.Recipe
  env?: Record<string, string>
  limits?: ControllerInput["limits"]
  fix?: ControllerInput["fix"]
  thumbnail?: ControllerInput["thumbnail"]
  auth?: boolean
  port?: number
  origin?: () => string | undefined
}) {
  const states: Preview.State[] = []
  const store = input.store ?? memoryStore()
  const controller = createController({
    directory: input.directory,
    hostname: "127.0.0.1",
    store,
    config: () => input.config,
    env: {
      ...(process.env as Record<string, string>),
      PATH: input.path,
      MODE: input.mode ?? "env-port",
      ...input.env,
    },
    emit: { changed: (status) => states.push(status.state), log: () => {} },
    limits: input.limits,
    fix: input.fix,
    thumbnail: input.thumbnail,
    auth: input.auth,
    port: input.port,
    origin: input.origin,
  })
  controllers.push(controller)
  return { controller, states, store }
}

function get(port: number, url = "/") {
  return new Promise<string>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path: url, headers: { accept: "text/html" } }, (res) => {
      const chunks: Buffer[] = []
      res.on("data", (chunk: Buffer) => chunks.push(chunk))
      res.on("end", () => resolve(Buffer.concat(chunks).toString()))
    })
    req.on("error", reject)
    req.end()
  })
}

function fetchRaw(port: number, url: string, cookie?: string) {
  return new Promise<{ status: number; cookie: string }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path: url, headers: cookie ? { cookie } : {} }, (res) => {
      res.resume()
      res.on("end", () =>
        resolve({
          status: res.statusCode ?? 0,
          cookie: (res.headers["set-cookie"] ?? []).map((value) => value.split(";")[0]).join("; "),
        }),
      )
    })
    req.on("error", reject)
    req.end()
  })
}

async function until(check: () => boolean, timeout = 15_000) {
  const deadline = Date.now() + timeout
  while (!check() && Date.now() < deadline) await Bun.sleep(50)
  return check()
}

describe("controller", () => {
  test("detects, installs and runs", async () => {
    const dir = await project()
    const { controller, states } = start(dir)
    const status = await controller.start()

    expect(status.state).toBe("running")
    expect(states).toContain("detecting")
    expect(states).toContain("installing")
    const body = await get(status.port!)
    expect(body).toContain("fake dev server")
    expect(body).toContain("/__omai/bridge.js")
    expect(status.framework).toBe("unknown")
  }, 30_000)

  test("asks when two apps are equally likely, and remembers the pick", async () => {
    const script = `node ${JSON.stringify(fakeServer)} || true`
    const dir = await project({
      "package.json": JSON.stringify({ name: "root", private: true }),
      "apps/a/package.json": JSON.stringify({ name: "a", scripts: { dev: script } }),
      "apps/b/package.json": JSON.stringify({ name: "b", scripts: { dev: script } }),
    })
    const { controller, store } = start(dir)
    const asked = await controller.start()

    expect(asked.state).toBe("choosing")
    expect(asked.candidates?.length).toBe(2)
    const picked = await controller.start({ candidate: 1 })
    expect(picked.state).toBe("running")
    expect(store.values.get("recipe")).toMatchObject({ root: "apps/b", source: "picked" })
  }, 30_000)

  test("uses the saved recipe without detecting", async () => {
    const dir = await project()
    const store = memoryStore()
    await start({ ...dir, store }).controller.start()
    const second = start({ ...dir, store })
    const status = await second.controller.start()

    expect(status.state).toBe("running")
    expect(second.states).not.toContain("detecting")
  }, 30_000)

  test("config wins over the saved recipe", async () => {
    const dir = await project()
    const store = memoryStore({
      recipe: { root: ".", kind: "command", command: "exit 1", source: "user" },
    })
    const status = await start({
      ...dir,
      store,
      config: { root: ".", kind: "command", command: `node ${JSON.stringify(fakeServer)}`, source: "config" },
    }).controller.start()

    expect(status.state).toBe("running")
    expect(status.recipe?.source).toBe("config")
  }, 30_000)

  test("restarts once after a crash, then reports the second", async () => {
    const dir = await project()
    const { controller, states } = start({ ...dir, mode: "crash", env: { CRASH_AFTER: "500" } })
    await controller.start()

    expect(await until(() => controller.status().state === "failed", 20_000)).toBe(true)
    expect(states.filter((state) => state === "running").length).toBe(2)
    expect(controller.status().reason).toContain("crashed")
  }, 30_000)

  test("reinstalls when package.json changes while running", async () => {
    const dir = await project()
    const { controller, states } = start(dir)
    await controller.start()
    const before = states.filter((state) => state === "installing").length
    const pkg = JSON.parse(await readFile(path.join(dir.directory, "package.json"), "utf8"))
    await writeFile(path.join(dir.directory, "package.json"), JSON.stringify({ ...pkg, version: "2.0.0" }))

    expect(await until(() => states.filter((state) => state === "installing").length > before)).toBe(true)
    expect(await until(() => controller.status().state === "running")).toBe(true)
  }, 30_000)

  test("stops when nobody watches", async () => {
    const dir = await project()
    const { controller } = start({ ...dir, limits: { idle: 300 } })
    await controller.start()

    expect(await until(() => controller.status().state === "stopped", 5_000)).toBe(true)
  }, 30_000)

  test("keeps running while watched", async () => {
    const dir = await project()
    const { controller } = start({ ...dir, limits: { idle: 300 } })
    await controller.start()
    const timer = setInterval(() => controller.watch(), 50)
    await Bun.sleep(1_000)
    clearInterval(timer)

    expect(controller.status().state).toBe("running")
  }, 30_000)

  test("fails with a reason and a log when nothing can start", async () => {
    const dir = await project({ "package.json": JSON.stringify({ name: "app" }) })
    const { controller } = start(dir)
    const status = await controller.start()

    expect(status.state).toBe("failed")
    expect(status.reason).toBeTruthy()
  }, 30_000)

  test("reuses its preview port across restarts", async () => {
    const dir = await project()
    const { controller } = start(dir)
    const first = await controller.start()
    const second = await controller.restart()

    expect(second.state).toBe("running")
    expect(second.port).toBe(first.port)
  }, 30_000)

  // On a VM the preview's port is published by Northflank, so it can't be a saved or free one.
  test("OMAI_PREVIEW_PORT fixes the proxy port", async () => {
    const dir = await project()
    const { freePort } = await import("@opencode/core/preview/ports")
    const fixed = await freePort()
    const store = memoryStore({ port: fixed + 1 })
    const { controller } = start({ ...dir, store, port: fixed })
    const status = await controller.start()

    expect(status.port).toBe(fixed)
    expect(await get(fixed)).toContain("fake dev server")
    expect(store.values.get("port")).toBe(fixed + 1)
  }, 30_000)

  // A VM's server keeps a preview for every folder it was asked about, and all of them share the published port: only
  // the one that starts may take it, or another folder's idle preview keeps it and this one can never start.
  test("a fixed port is taken by the preview that starts, not by one that merely exists", async () => {
    const dir = await project()
    const other = await project()
    const { freePort } = await import("@opencode/core/preview/ports")
    const fixed = await freePort()
    start({ ...other, port: fixed })
    const { controller } = start({ ...dir, port: fixed })
    await Bun.sleep(100)
    const status = await controller.start()

    expect(status.state).toBe("running")
    expect(await get(fixed)).toContain("fake dev server")
  }, 30_000)

  test("the status carries the public origin once it is known", async () => {
    const dir = await project()
    const origin: { value?: string } = {}
    const { controller } = start({ ...dir, origin: () => origin.value })
    expect(controller.status().origin).toBeUndefined()
    // Running, but the public address isn't known yet: no port either, or the app would load the server's own host.
    const early = await controller.start()
    expect(early.state).toBe("running")
    expect(early.port).toBeUndefined()
    expect(controller.status().port).toBeUndefined()
    origin.value = "https://p--preview.code.run"
    expect(controller.status().origin).toBe("https://p--preview.code.run")
    expect(controller.status().port).toBeNumber()
    expect((await controller.start()).origin).toBe("https://p--preview.code.run")
  }, 30_000)

  // The VM's server restarts (and will on every pause and resume); a preview the browser already entered must not
  // say its link expired.
  test("keeps the preview sign-in across server restarts", async () => {
    const dir = await project()
    const store = memoryStore()
    const first = start({ ...dir, store, auth: true })
    const status = await first.controller.start()
    const entered = await fetchRaw(status.port!, `/__omai/enter?ticket=${first.controller.ticket()}&to=%2F`)
    await first.controller.close()
    const second = start({ ...dir, store, auth: true })
    const again = await second.controller.start()

    expect(entered.status).toBe(302)
    expect((await fetchRaw(again.port!, "/", entered.cookie)).status).toBe(200)
    expect((await fetchRaw(again.port!, "/")).status).toBe(401)
  }, 30_000)

  test("asks the AI once per version of the project, unless asked again", async () => {
    const dir = await project({ "package.json": JSON.stringify({ name: "app" }) })
    const calls = { count: 0 }
    const store = memoryStore()
    const { controller } = start({
      ...dir,
      store,
      fix: async () => {
        calls.count++
        return { reason: "Not a web project." }
      },
    })
    const first = await controller.start({ sessionID: "ses_1" })
    await controller.start({ sessionID: "ses_1" })

    expect(first).toMatchObject({ state: "failed", reason: "Not a web project." })
    expect(calls.count).toBe(1)
    await controller.start({ sessionID: "ses_1", retry: true })
    expect(calls.count).toBe(2)
    await writeFile(path.join(dir.directory, "package.json"), JSON.stringify({ name: "app", version: "2.0.0" }))
    await controller.start({ sessionID: "ses_1" })
    expect(calls.count).toBe(3)
  }, 30_000)

  test("dev servers don't see agent or server variables", () => {
    const env = devEnv(
      {
        PATH: "/bin",
        HOME: "/home/a",
        CLAUDECODE: "1",
        OPENCODE: "1",
        CODEX_THREAD_ID: "t",
        OMAI_PASSWORD: "x",
        AGENT: "y",
      },
      "/project",
      "/project",
      5000,
    )

    expect(env.PATH.startsWith("/project/node_modules/.bin")).toBe(true)
    expect(env.HOME).toBe("/home/a")
    expect(env.PORT).toBe("5000")
    expect(Object.keys(env)).not.toContain("CLAUDECODE")
    expect(Object.keys(env)).not.toContain("OPENCODE")
    expect(Object.keys(env)).not.toContain("CODEX_THREAD_ID")
    expect(Object.keys(env)).not.toContain("OMAI_PASSWORD")
    expect(Object.keys(env)).not.toContain("AGENT")
  })

  test("an empty project shows nothing to preview, then starts once a page appears", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "omai-empty-"))
    const { controller } = start({ directory, path: process.env.PATH ?? "" })
    const status = await controller.start({ sessionID: "ses_1" })

    expect(status.state).toBe("empty")
    await writeFile(path.join(directory, "index.html"), "<h1>hi</h1>")
    expect(await until(() => controller.status().state === "running", 10_000)).toBe(true)
  }, 30_000)

  test("a saved dev server recipe for a folder whose app was removed shows nothing to preview", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "omai-emptied-"))
    // What a dev server leaves behind; hidden files are not the project's own.
    await mkdir(path.join(directory, ".vite"), { recursive: true })
    const store = memoryStore({
      recipe: { root: ".", kind: "command", command: "vite dev --port {port}", source: "detected" },
    })
    const status = await start({ directory, path: process.env.PATH ?? "", store }).controller.start()

    expect(status.state).toBe("empty")
    expect(store.values.get("recipe")).toBeUndefined()
  }, 30_000)

  test("takes a thumbnail of the running app from the dev server itself", async () => {
    const dir = await project()
    const captured: string[] = []
    const { controller } = start({
      ...dir,
      limits: { captureDelay: 20 },
      thumbnail: { capture: async (url) => void captured.push(url) },
    })
    await controller.start()
    await new Promise((resolve) => setTimeout(resolve, 200))

    expect(captured).toEqual([`http://127.0.0.1:${controller.upstream()}/`])
    expect(await get(controller.upstream()!)).toContain("fake dev server")
  }, 30_000)

  test("asset writes into public and returns its url", async () => {
    const dir = await project({ "public/.keep": "" })
    const { controller } = start(dir)
    const status = await controller.start()
    const png = Buffer.from("png-bytes").toString("base64")

    expect(await controller.asset({ name: "logo.png", base64: png })).toEqual({
      url: "/images/logo.png",
      path: "public/images/logo.png",
    })
    expect(await controller.asset({ name: "logo.png", base64: png })).toEqual({
      url: "/images/logo-1.png",
      path: "public/images/logo-1.png",
    })
    expect(await readFile(path.join(dir.directory, "public/images/logo.png"), "utf8")).toBe("png-bytes")
    // The preview shows the upload at once, whether or not the dev server serves new public files yet.
    expect(await get(status.port!, "/images/logo.png")).toBe("png-bytes")
  }, 30_000)

  test("asset rejects other file types and paths that escape", async () => {
    const dir = await project()
    const { controller } = start(dir)
    await controller.start()
    const data = Buffer.from("x").toString("base64")

    expect(await controller.asset({ name: "../../evil.png", base64: data })).toEqual({
      url: "/images/evil.png",
      path: "public/images/evil.png",
    })
    await expect(controller.asset({ name: "run.exe", base64: data })).rejects.toThrow()
  }, 30_000)

  test("detects again when a saved static site lost its index.html", async () => {
    const dir = await project({ "package.json": JSON.stringify({ name: "site" }), "site/index.html": "<h1>site</h1>" })
    const store = memoryStore({ recipe: { root: ".", kind: "static", source: "detected" } })
    const status = await start({ ...dir, store }).controller.start()

    expect(status.state).toBe("running")
    expect(status.recipe?.root).toBe("site")
  }, 30_000)
})
