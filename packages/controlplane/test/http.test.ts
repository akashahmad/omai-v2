import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { eq } from "drizzle-orm"
import { SignedToken } from "@opencode/util/signed-token"
import { ControlPlane } from "../src/control-plane.js"
import { Database } from "../src/db/database.js"
import { ProjectTable } from "../src/db/schema.js"
import { Users } from "../src/users.js"
import { fakeVmCommand, testConfig, until } from "./fixture/setup.js"

const APP = "http://app.test"
const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((fn) => fn()))
})

async function setup(env: Record<string, string> = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "omai-cp-http-"))
  const config = testConfig({
    OMAI_CONTROLPLANE_PORT: "0",
    OMAI_CONTROLPLANE_INTERNAL_PORT: "0",
    OMAI_LOCAL_PROJECTS_ROOT: root,
    OMAI_LOCAL_SERVE_COMMAND: fakeVmCommand,
    ...env,
  })
  const db = await Database.memory()
  await Users.create(db, { username: "a", email: "a@x.y", password: "pw-a", admin: true })
  await Users.create(db, { username: "b", email: "b@x.y", password: "pw-b" })
  const cp = await ControlPlane.start(config, db)
  cleanup.push(() => cp.close())
  const base = `http://127.0.0.1:${cp.port}`
  const internal = `http://127.0.0.1:${cp.internalPort}`

  async function call(
    method: string,
    route: string,
    input: { token?: string; body?: unknown; origin?: string; cookie?: string } = {},
  ) {
    const res = await fetch(base + route, {
      method,
      headers: {
        origin: input.origin ?? APP,
        ...(input.token ? { authorization: `Bearer ${input.token}` } : {}),
        ...(input.cookie ? { cookie: input.cookie } : {}),
        ...(input.body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: input.body !== undefined ? JSON.stringify(input.body) : undefined,
    })
    const text = await res.text()
    return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : undefined }
  }

  async function login(name: "a" | "b") {
    const res = await call("POST", "/auth/login", { body: { login: name, password: `pw-${name}` } })
    expect(res.status).toBe(200)
    return { token: res.body.accessToken as string, cookie: res.headers.get("set-cookie")!.split(";")[0]! }
  }

  const raw = (method: string, route: string, token: string) =>
    fetch(base + route, { method, headers: { origin: APP, authorization: `Bearer ${token}` } })

  /** A project of user a with a running VM, and the project token its VM holds. */
  async function runningProject(token: string, name = "Shop") {
    const created = await call("POST", "/projects", { token, body: { name } })
    await until(
      () => call("GET", `/projects/${created.body.id}`, { token }),
      (res) => res.body.vmState === "running",
    )
    const opened = (await call("POST", `/projects/${created.body.id}/open`, { token })).body.token
    const vmHost = (SignedToken.verify(opened, config.publicKey) as SignedToken.VmClaims).host
    return { id: created.body.id as string, vmHost, projectToken: await fetch(`${vmHost}/token`).then((r) => r.text()) }
  }

  const post = (route: string, input: { token?: string; body?: unknown } = {}) =>
    fetch(internal + route, {
      method: "POST",
      headers: {
        ...(input.token ? { authorization: `Bearer ${input.token}` } : {}),
        "content-type": "application/json",
      },
      body: input.body !== undefined ? JSON.stringify(input.body) : undefined,
    })

  return { config, db, cp, call, login, internal, raw, runningProject, post }
}

describe("control plane http", () => {
  test("full flow", async () => {
    const s = await setup()
    const a = await s.login("a")
    const created = await s.call("POST", "/projects", { token: a.token, body: { name: "Shop" } })
    expect(created.status).toBe(201)
    await until(
      () => s.call("GET", `/projects/${created.body.id}`, { token: a.token }),
      (res) => res.body.vmState === "running",
    )
    const opened = await s.call("POST", `/projects/${created.body.id}/open`, { token: a.token })
    expect(opened.status).toBe(200)
    expect(opened.body.routerUrl.endsWith(`/vm/${created.body.id}`)).toBe(true)
    const claims = SignedToken.verify(opened.body.token, s.config.publicKey)
    expect(claims?.typ === "vm" && claims.pid).toBe(created.body.id)
    const list = await s.call("GET", "/projects", { token: a.token })
    expect(list.body.map((p: { id: string }) => p.id)).toEqual([created.body.id])
    expect((await s.call("POST", "/projects", { token: a.token, body: { name: "shop" } })).status).toBe(409)
    expect((await s.call("POST", "/projects", { token: a.token, body: { name: "" } })).status).toBe(400)
    expect((await s.call("POST", "/projects", { token: a.token, body: "nonsense" })).status).toBe(400)
  })

  test("open is 409 while the VM is not ready", async () => {
    const s = await setup()
    const a = await s.login("a")
    const created = await s.call("POST", "/projects", { token: a.token, body: { name: "Shop" } })
    const opened = await s.call("POST", `/projects/${created.body.id}/open`, { token: a.token })
    expect(opened.status).toBe(409)
    expect(opened.body).toEqual({ error: "not-ready" })
  })

  test("requests without a valid token are 401", async () => {
    const s = await setup()
    expect((await s.call("GET", "/projects")).status).toBe(401)
    expect((await s.call("GET", "/projects", { token: "garbage" })).body).toEqual({ error: "unauthenticated" })
  })

  test("signup hidden when disabled", async () => {
    const s = await setup()
    expect((await s.call("GET", "/config")).body).toEqual({ signupEnabled: false })
    expect(
      (await s.call("POST", "/auth/signup", { body: { username: "c", email: "c@x.y", password: "pw" } })).status,
    ).toBe(404)
  })

  test("signup when enabled", async () => {
    const s = await setup({ OMAI_SIGNUP_ENABLED: "true" })
    const res = await s.call("POST", "/auth/signup", { body: { username: "c", email: "c@x.y", password: "pw-c-1234" } })
    expect(res.status).toBe(200)
    expect(res.body.user.username).toBe("c")
    expect(
      (await s.call("POST", "/auth/signup", { body: { username: "c", email: "d@x.y", password: "pw-long-enough" } }))
        .status,
    ).toBe(409)
  })

  test("wrong login is 401 invalid", async () => {
    const s = await setup()
    const res = await s.call("POST", "/auth/login", { body: { login: "a", password: "nope" } })
    expect(res.status).toBe(401)
    expect(res.body).toEqual({ error: "invalid" })
  })

  test("cross-user 404s", async () => {
    const s = await setup()
    const a = await s.login("a")
    const b = await s.login("b")
    const created = await s.call("POST", "/projects", { token: a.token, body: { name: "Shop" } })
    const id = created.body.id
    expect((await s.call("GET", `/projects/${id}`, { token: b.token })).status).toBe(404)
    expect((await s.call("PATCH", `/projects/${id}`, { token: b.token, body: { name: "Mine" } })).status).toBe(404)
    expect((await s.call("DELETE", `/projects/${id}`, { token: b.token })).status).toBe(404)
    expect((await s.call("POST", `/projects/${id}/retry`, { token: b.token })).status).toBe(404)
    expect((await s.call("POST", `/projects/${id}/open`, { token: b.token })).status).toBe(404)
    expect((await s.call("GET", `/projects/${id}`, { token: a.token })).body.name).toBe("Shop")
  })

  test("rename and delete", async () => {
    const s = await setup()
    const a = await s.login("a")
    const created = await s.call("POST", "/projects", { token: a.token, body: { name: "Shop" } })
    const renamed = await s.call("PATCH", `/projects/${created.body.id}`, { token: a.token, body: { name: "Store" } })
    expect(renamed.body.name).toBe("Store")
    expect((await s.call("DELETE", `/projects/${created.body.id}`, { token: a.token })).status).toBe(204)
    expect((await s.call("GET", `/projects/${created.body.id}`, { token: a.token })).status).toBe(404)
  })

  test("wrong origin is 403", async () => {
    const s = await setup()
    const a = await s.login("a")
    const res = await s.call("POST", "/projects", {
      token: a.token,
      body: { name: "Shop" },
      origin: "http://evil.test",
    })
    expect(res.status).toBe(403)
    expect(
      (await s.call("POST", "/auth/login", { body: { login: "a", password: "pw-a" }, origin: "http://evil.test" }))
        .status,
    ).toBe(403)
  })

  test("cors allows only the app origin with credentials", async () => {
    const s = await setup()
    const ok = await s.call("OPTIONS", "/projects")
    expect(ok.status).toBe(204)
    expect(ok.headers.get("access-control-allow-origin")).toBe(APP)
    expect(ok.headers.get("access-control-allow-credentials")).toBe("true")
    expect((await s.call("OPTIONS", "/projects", { origin: "http://evil.test" })).status).toBe(403)
  })

  test("refresh cookie is host-only", async () => {
    const s = await setup()
    const res = await s.call("POST", "/auth/login", { body: { login: "a", password: "pw-a" } })
    const cookie = res.headers.get("set-cookie")!
    expect(cookie.startsWith("omai_refresh=")).toBe(true)
    expect(cookie).toContain("HttpOnly")
    expect(cookie).toContain("SameSite=Lax")
    expect(cookie).not.toContain("Domain=")
    expect(cookie).not.toContain("Secure")
  })

  test("https app origin uses a __Host- secure cookie", async () => {
    const s = await setup({ OMAI_APP_ORIGIN: "https://app.omai.ch" })
    const res = await s.call("POST", "/auth/login", {
      body: { login: "a", password: "pw-a" },
      origin: "https://app.omai.ch",
    })
    const cookie = res.headers.get("set-cookie")!
    expect(cookie.startsWith("__Host-omai_refresh=")).toBe(true)
    expect(cookie).toContain("Secure")
    expect(cookie).toContain("Path=/")
  })

  test("refresh, ping and logout", async () => {
    const s = await setup()
    const a = await s.login("a")
    const refreshed = await s.call("POST", "/auth/refresh", { cookie: a.cookie })
    expect(refreshed.status).toBe(200)
    expect(refreshed.body.user.username).toBe("a")
    expect((await s.call("POST", "/auth/ping", { token: a.token })).status).toBe(204)
    const sid = (SignedToken.verify(a.token, s.config.publicKey) as SignedToken.AccessClaims).sid
    expect((await fetch(`${s.internal}/internal/sessions/${sid}`)).status).toBe(200)
    expect((await s.call("POST", "/auth/logout", { token: a.token })).status).toBe(204)
    expect((await fetch(`${s.internal}/internal/sessions/${sid}`)).status).toBe(404)
    const after = await s.call("POST", "/auth/refresh", { cookie: a.cookie })
    expect(after.status).toBe(401)
    expect(after.headers.get("set-cookie")).toContain("Max-Age=0")
    expect((await s.call("POST", "/auth/refresh")).status).toBe(401)
  })

  test("summary needs that project's token", async () => {
    const s = await setup()
    const a = await s.login("a")
    const b = await s.login("b")
    const pa = await s.call("POST", "/projects", { token: a.token, body: { name: "A" } })
    const pb = await s.call("POST", "/projects", { token: b.token, body: { name: "B" } })
    const running = (token: string, id: string) =>
      until(
        () => s.call("GET", `/projects/${id}`, { token }),
        (res) => res.body.vmState === "running",
      )
    await running(a.token, pa.body.id)
    await running(b.token, pb.body.id)
    const host = (await s.call("POST", `/projects/${pa.body.id}/open`, { token: a.token })).body.token
    const vmHost = (SignedToken.verify(host, s.config.publicKey) as SignedToken.VmClaims).host
    const projectToken = await fetch(`${vmHost}/token`).then((r) => r.text())
    const post = (id: string, token: string) =>
      fetch(`${s.internal}/internal/projects/${id}/summary`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ title: "Hijack", at: 1 }),
      })
    expect((await post(pb.body.id, projectToken)).status).toBe(401)
    expect((await s.call("GET", `/projects/${pb.body.id}`, { token: b.token })).body.lastSession).toBeUndefined()
    expect((await post(pa.body.id, projectToken)).status).toBe(204)
    expect((await s.call("GET", `/projects/${pa.body.id}`, { token: a.token })).body.lastSession).toEqual({
      title: "Hijack",
      at: 1,
    })
  })

  test("thumbnails: the project's VM pushes one, only its owner reads it", async () => {
    const s = await setup()
    const a = await s.login("a")
    const b = await s.login("b")
    const pa = await s.call("POST", "/projects", { token: a.token, body: { name: "A" } })
    const pb = await s.call("POST", "/projects", { token: b.token, body: { name: "B" } })
    await until(
      () => s.call("GET", `/projects/${pa.body.id}`, { token: a.token }),
      (res) => res.body.vmState === "running",
    )
    const opened = (await s.call("POST", `/projects/${pa.body.id}/open`, { token: a.token })).body.token
    const vmHost = (SignedToken.verify(opened, s.config.publicKey) as SignedToken.VmClaims).host
    const projectToken = await fetch(`${vmHost}/token`).then((r) => r.text())
    const image = new Uint8Array([82, 73, 70, 70, 1, 2, 3, 4])
    const push = (id: string) =>
      fetch(`${s.internal}/internal/projects/${id}/thumbnail`, {
        method: "POST",
        headers: { authorization: `Bearer ${projectToken}`, "content-type": "image/webp" },
        body: image,
      })

    expect((await push(pb.body.id)).status).toBe(401)
    expect((await push(pa.body.id)).status).toBe(204)
    const view = await s.call("GET", `/projects/${pa.body.id}`, { token: a.token })
    expect(view.body.thumbnail).toMatch(/^[a-f0-9]{64}$/)
    const read = (token: string) => s.raw("GET", `/projects/${pa.body.id}/thumbnail`, token)
    const own = await read(a.token)
    expect(own.status).toBe(200)
    expect(own.headers.get("content-type")).toBe("image/webp")
    expect(new Uint8Array(await own.arrayBuffer())).toEqual(image)
    expect(own.headers.get("etag")).toBe(`"${view.body.thumbnail}"`)
    expect((await read(b.token)).status).toBe(404)
    expect((await s.call("GET", `/projects/${pb.body.id}`, { token: b.token })).body.thumbnail).toBeUndefined()
  })

  test("the router can look up a running project's address, nothing more", async () => {
    const s = await setup()
    const a = await s.login("a")
    const created = await s.call("POST", "/projects", { token: a.token, body: { name: "Shop" } })
    const host = () => fetch(`${s.internal}/internal/projects/${created.body.id}/host`)
    expect((await host()).status).toBe(404)
    await until(
      () => s.call("GET", `/projects/${created.body.id}`, { token: a.token }),
      (res) => res.body.vmState === "running",
    )
    const found = await host()
    expect(found.status).toBe(200)
    expect(Object.keys(await found.json())).toEqual(["host"])
    expect((await fetch(`${s.internal}/internal/projects/nope/host`)).status).toBe(404)
    await s.call("DELETE", `/projects/${created.body.id}`, { token: a.token })
    expect((await host()).status).toBe(404)
  })

  test("publishing routes act only on the project whose token the request carries", async () => {
    const s = await setup()
    const a = await s.login("a")
    const b = await s.login("b")
    const pa = await s.runningProject(a.token, "A")
    const pb = await s.runningProject(b.token, "B")
    const routes = [
      ["GET", `/internal/projects/${pb.id}/publish`],
      ["POST", `/internal/projects/${pb.id}/publish/claim`],
      ["POST", `/internal/projects/${pb.id}/publish/deploy?kind=static`],
      ["POST", `/internal/projects/${pb.id}/publish/release`],
      ["DELETE", `/internal/projects/${pb.id}/publish`],
      ["GET", `/internal/projects/${pb.id}/domains`],
      ["POST", `/internal/projects/${pb.id}/domains`],
      ["DELETE", `/internal/projects/${pb.id}/domains/www.b.edu`],
    ] as const
    for (const [method, route] of routes) {
      const res = await fetch(s.internal + route, { method, headers: { authorization: `Bearer ${pa.projectToken}` } })
      expect([method, route, res.status]).toEqual([method, route, 401])
    }
    // Its own project answers, and without Cloudflare settings it says so.
    const own = await fetch(`${s.internal}/internal/projects/${pa.id}/publish`, {
      headers: { authorization: `Bearer ${pa.projectToken}` },
    })
    expect(await own.json()).toEqual({ configured: false })
    const claim = await s.post(`/internal/projects/${pa.id}/publish/claim`, {
      token: pa.projectToken,
      body: { name: "x" },
    })
    expect(claim.status).toBe(503)
    expect(await claim.json()).toEqual({ kind: "not-configured", message: "Publishing isn't set up on this server." })
  })

  test("the vm route answers only for the project's own token", async () => {
    const s = await setup()
    const a = await s.login("a")
    const b = await s.login("b")
    const mine = await s.runningProject(a.token, "Mine")
    const theirs = await s.runningProject(b.token, "Theirs")
    const vm = (id: string, token: string) =>
      fetch(`${s.internal}/internal/projects/${id}/vm`, { headers: { authorization: `Bearer ${token}` } })
    expect((await vm(theirs.id, mine.projectToken)).status).toBe(401)
    expect((await vm(mine.id, "nope")).status).toBe(401)
    const local = await vm(mine.id, mine.projectToken)
    expect(local.status).toBe(200)
    // Its folder name, which a reserve's VM learns here once claimed.
    expect(await local.json()).toEqual({ slug: expect.any(String) })
    await s.db.update(ProjectTable).set({ vm_preview: "https://p.code.run" }).where(eq(ProjectTable.id, mine.id))
    expect(await (await vm(mine.id, mine.projectToken)).json()).toEqual({
      preview: "https://p.code.run",
      slug: expect.any(String),
    })
  })

  test("busy push needs the project's own token and records the report", async () => {
    const s = await setup()
    const a = await s.login("a")
    const b = await s.login("b")
    const pa = await s.runningProject(a.token, "A")
    const pb = await s.runningProject(b.token, "B")
    const report = { busy: true, reasons: ["sessions:1"] }
    expect((await s.post(`/internal/projects/${pb.id}/busy`, { token: pa.projectToken, body: report })).status).toBe(
      401,
    )
    expect(s.cp.lifecycle.latestBusy(pb.id)).toBeUndefined()
    expect(
      (await s.post(`/internal/projects/${pa.id}/busy`, { token: pa.projectToken, body: { busy: 1 } })).status,
    ).toBe(400)
    expect((await s.post(`/internal/projects/${pa.id}/busy`, { token: pa.projectToken, body: report })).status).toBe(
      204,
    )
    expect(s.cp.lifecycle.latestBusy(pa.id)).toEqual(report)
  })

  test("presence touches only the owner's project", async () => {
    const s = await setup()
    const a = await s.login("a")
    const b = await s.login("b")
    const pa = await s.runningProject(a.token)
    expect((await s.call("POST", `/projects/${pa.id}/presence`, { token: b.token })).status).toBe(404)
    expect((await s.call("POST", `/projects/${pa.id}/presence`, { token: a.token })).status).toBe(204)
  })

  test("wake answers 202 and the VM ends running", async () => {
    const s = await setup()
    const a = await s.login("a")
    const b = await s.login("b")
    const pa = await s.runningProject(a.token)
    await s.cp.lifecycle.pause(pa.id, "test")
    expect((await s.call("POST", `/projects/${pa.id}/wake`, { token: b.token })).status).toBe(404)
    expect((await s.call("POST", `/projects/${pa.id}/wake`, { token: a.token })).status).toBe(202)
    await until(
      () => s.call("GET", `/projects/${pa.id}`, { token: a.token }),
      (res) => res.body.vmState === "running",
    )
  })

  test("internal wake returns the host and refuses a deleted project", async () => {
    const s = await setup()
    const a = await s.login("a")
    const pa = await s.runningProject(a.token)
    await s.cp.lifecycle.pause(pa.id, "test")
    const woken = await s.post(`/internal/projects/${pa.id}/wake`)
    expect(woken.status).toBe(200)
    expect(await woken.json()).toEqual({ host: pa.vmHost })
    expect((await fetch(`${pa.vmHost}/api/info`)).status).toBe(200)
    await s.call("DELETE", `/projects/${pa.id}`, { token: a.token })
    expect((await s.post(`/internal/projects/${pa.id}/wake`)).status).toBe(404)
    expect((await s.post(`/internal/projects/nope/wake`)).status).toBe(404)
  })

  test("activity counts only for live projects", async () => {
    const s = await setup()
    const a = await s.login("a")
    const pa = await s.runningProject(a.token)
    expect((await s.post(`/internal/projects/${pa.id}/activity`)).status).toBe(204)
    await s.call("DELETE", `/projects/${pa.id}`, { token: a.token })
    expect((await s.post(`/internal/projects/${pa.id}/activity`)).status).toBe(404)
    expect((await s.post(`/internal/projects/nope/activity`)).status).toBe(404)
  })

  test("presence wakes the paused project its user is looking at", async () => {
    const s = await setup()
    const a = await s.login("a")
    const pa = await s.runningProject(a.token)
    await s.cp.lifecycle.pause(pa.id, "test")
    expect((await s.call("POST", `/projects/${pa.id}/presence`, { token: a.token })).status).toBe(204)
    await until(
      () => s.call("GET", `/projects/${pa.id}`, { token: a.token }),
      (res) => res.body.vmState === "running",
    )
  })

  test("the platform server and its models are for admins only", async () => {
    const s = await setup()
    const a = await s.login("a")
    const b = await s.login("b")
    expect((await s.call("POST", "/platform/open", { token: b.token })).status).toBe(404)
    expect((await s.call("GET", "/platform/models", { token: b.token })).status).toBe(404)
    const models = { models: [{ providerID: "openai", modelID: "gpt-5" }] }
    expect((await s.call("PUT", "/platform/models", { token: b.token, body: models })).status).toBe(404)
    const opened = await s.call("POST", "/platform/open", { token: a.token })
    expect(opened.status).toBe(200)
    expect(opened.body.routerUrl.endsWith("/vm/platform")).toBe(true)
    expect((await s.call("PUT", "/platform/models", { token: a.token, body: models })).status).toBe(204)
    expect((await s.call("PUT", "/platform/models", { token: a.token, body: { models: "x" } })).status).toBe(400)
    expect((await s.call("GET", "/platform/models", { token: a.token })).body).toEqual(models.models)
  })

  test("platform sessions: live and still an admin", async () => {
    const s = await setup()
    const a = await s.login("a")
    const b = await s.login("b")
    const sid = (token: string) => (SignedToken.verify(token, s.config.publicKey) as { sid: string }).sid
    const check = (token: string) =>
      fetch(`${s.internal}/internal/sessions/${sid(token)}?admin=1`).then((r) => r.status)
    expect(await check(a.token)).toBe(200)
    expect(await check(b.token)).toBe(404)
    expect((await fetch(`${s.internal}/internal/sessions/${sid(b.token)}`)).status).toBe(200)
    await Users.setAdmin(s.db, "a", false)
    expect(await check(a.token)).toBe(404)
  })

  test("a VM reads and writes only its owner's credentials, and reports usage", async () => {
    const s = await setup()
    const a = await s.login("a")
    const b = await s.login("b")
    const pa = await s.runningProject(a.token, "A")
    const pb = await s.runningProject(b.token, "B")
    const put = (project: { id: string; projectToken: string }, credentialID: string, updatedAt: number) =>
      fetch(`${s.internal}/internal/projects/${project.id}/credentials/${credentialID}`, {
        method: "PUT",
        headers: { authorization: `Bearer ${project.projectToken}`, "content-type": "application/json" },
        body: JSON.stringify({
          integrationID: "openai",
          label: "Mine",
          value: { type: "key", key: "sk-a" },
          updatedAt,
        }),
      }).then((r) => r.status)
    const keys = (project: { id: string; projectToken: string }) =>
      fetch(`${s.internal}/internal/projects/${project.id}/keys`, {
        headers: { authorization: `Bearer ${project.projectToken}` },
      }).then((r) => r.json() as Promise<{ shared: unknown[]; personal: { id: string }[] }>)
    expect(await put(pa, "c1", 10)).toBe(204)
    expect(await put(pa, "c1", 5)).toBe(409)
    expect(await put(pb, "c1", 20)).toBe(404)
    // B's token can't act for A's project either.
    expect(await put({ id: pa.id, projectToken: pb.projectToken }, "c2", 1)).toBe(401)
    expect((await keys(pa)).personal.map((item) => item.id)).toEqual(["c1"])
    expect((await keys(pb)).personal).toEqual([])
    const removed = await fetch(`${s.internal}/internal/projects/${pa.id}/credentials/c1?at=30`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${pa.projectToken}` },
    })
    expect(removed.status).toBe(204)
    const usage = await fetch(`${s.internal}/internal/projects/${pa.id}/usage`, {
      method: "POST",
      headers: { authorization: `Bearer ${pa.projectToken}`, "content-type": "application/json" },
      body: JSON.stringify({
        steps: [{ providerID: "openai", modelID: "gpt-5", inputTokens: 1, outputTokens: 2, at: 1 }],
      }),
    })
    expect(usage.status).toBe(204)
  })

  test("every signed-in user can see which models are shared (names only)", async () => {
    const s = await setup()
    const a = await s.login("a")
    const b = await s.login("b")
    await s.call("PUT", "/platform/models", {
      token: a.token,
      body: { models: [{ providerID: "openai", modelID: "gpt-5" }] },
    })
    const shared = await s.call("GET", "/models/shared", { token: b.token })
    expect(shared.status).toBe(200)
    expect(shared.body).toEqual([{ providerID: "openai", modelID: "gpt-5" }])
    expect((await s.call("GET", "/models/shared")).status).toBe(401)
  })

  test("each user's model switches are their own, and the last switch wins", async () => {
    const s = await setup()
    const a = await s.login("a")
    const b = await s.login("b")
    const gpt = { providerID: "openai", modelID: "gpt-5" }
    expect((await s.call("PUT", "/models/mine", { token: a.token, body: { ...gpt, visible: true } })).status).toBe(204)
    expect(
      (
        await s.call("PUT", "/models/mine", {
          token: a.token,
          body: { providerID: "anthropic", modelID: "x", visible: false },
        })
      ).status,
    ).toBe(204)
    expect((await s.call("PUT", "/models/mine", { token: a.token, body: { ...gpt, visible: false } })).status).toBe(204)
    expect((await s.call("GET", "/models/mine", { token: a.token })).body).toEqual([
      { providerID: "anthropic", modelID: "x", visible: false },
      { ...gpt, visible: false },
    ])
    expect((await s.call("GET", "/models/mine", { token: b.token })).body).toEqual([])
    expect((await s.call("PUT", "/models/mine", { token: a.token, body: { ...gpt, visible: "yes" } })).status).toBe(400)
    expect((await s.call("GET", "/models/mine")).status).toBe(401)
  })
})

describe("users and roles", () => {
  test("only admins manage users; restrictions reach the user's sign-in", async () => {
    const s = await setup()
    const a = await s.login("a")
    const b = await s.login("b")
    expect((await s.call("GET", "/admin/users", { token: b.token })).status).toBe(404)
    const listed = await s.call("GET", "/admin/users", { token: a.token })
    expect(listed.body.map((user: { username: string; admin: boolean }) => [user.username, user.admin])).toEqual([
      ["a", true],
      ["b", false],
    ])
    await s.call("PUT", "/platform/models", { token: a.token, body: { models: [{ providerID: "p", modelID: "m" }] } })

    const invalid = await s.call("POST", "/admin/users", {
      token: a.token,
      body: { username: "c", email: "c@x.y", password: "long-enough-pw" },
    })
    expect(invalid.body).toEqual({ error: "invalid-username" })
    expect(
      (
        await s.call("POST", "/admin/users", {
          token: a.token,
          body: { username: "carol", email: "c@x.y", password: "short" },
        })
      ).body,
    ).toEqual({ error: "weak-password" })
    expect(
      (
        await s.call("POST", "/admin/users", {
          token: a.token,
          body: {
            username: "carol",
            email: "c@x.y",
            password: "long-enough-pw",
            model: { providerID: "p", modelID: "x" },
          },
        })
      ).body,
    ).toEqual({ error: "invalid-model" })

    const created = await s.call("POST", "/admin/users", {
      token: a.token,
      body: {
        username: "carol",
        email: "c@x.y",
        password: "long-enough-pw",
        hidden: ["terminal"],
        model: { providerID: "p", modelID: "m" },
      },
    })
    expect(created.status).toBe(201)
    expect(created.body).toMatchObject({ username: "carol", admin: false, hidden: ["terminal"] })
    expect(
      (
        await s.call("POST", "/admin/users", {
          token: a.token,
          body: { username: "carol", email: "other@x.y", password: "long-enough-pw" },
        })
      ).status,
    ).toBe(409)

    const login = await s.call("POST", "/auth/login", { body: { login: "carol", password: "long-enough-pw" } })
    expect(login.body.user).toMatchObject({ hidden: ["terminal"], model: { providerID: "p", modelID: "m" } })

    const updated = await s.call("PATCH", `/admin/users/${created.body.id}`, {
      token: a.token,
      body: { hidden: [], model: null },
    })
    expect(updated.body).toMatchObject({ hidden: [], model: null })
    const promoted = await s.call("PATCH", `/admin/users/${created.body.id}`, { token: a.token, body: { admin: true } })
    expect(promoted.body.admin).toBe(true)

    const self = listed.body.find((user: { username: string }) => user.username === "a").id
    expect((await s.call("PATCH", `/admin/users/${self}`, { token: a.token, body: { admin: false } })).body).toEqual({
      error: "self-demote",
    })
    expect((await s.call("DELETE", `/admin/users/${self}`, { token: a.token })).body).toEqual({ error: "self-delete" })

    expect((await s.call("DELETE", `/admin/users/${created.body.id}`, { token: a.token })).status).toBe(204)
    expect((await s.call("POST", "/auth/login", { body: { login: "carol", password: "long-enough-pw" } })).status).toBe(
      401,
    )
    // The deleted user's name is free again.
    expect(
      (
        await s.call("POST", "/admin/users", {
          token: a.token,
          body: { username: "carol", email: "c@x.y", password: "long-enough-pw" },
        })
      ).status,
    ).toBe(201)
  })
})

describe("shared conversations", () => {
  test("the owner shares, updates and ends a link anyone can read", async () => {
    const s = await setup()
    const a = await s.login("a")
    const b = await s.login("b")
    const project = (await s.call("POST", "/projects", { token: a.token, body: { name: "Shop" } })).body.id as string
    const route = `/projects/${project}/shares/ses_1`
    const copy = { title: "Hello", data: { session: { id: "ses_1" }, messages: [{ id: "msg_1" }] } }

    expect((await s.call("GET", route, { token: a.token })).status).toBe(404)
    expect((await s.call("PUT", route, { token: b.token, body: copy })).status).toBe(404)
    const shared = await s.call("PUT", route, { token: a.token, body: copy })
    expect(shared.status).toBe(200)
    const id = shared.body.id as string
    expect((await s.call("GET", route, { token: a.token })).body.id).toBe(id)

    const read = await s.call("GET", `/shares/${id}`)
    expect(read.status).toBe(200)
    expect(read.body).toMatchObject({ id, title: "Hello", data: copy.data })

    // Updating keeps the link.
    const again = await s.call("PUT", route, { token: a.token, body: { ...copy, title: "Renamed" } })
    expect(again.body.id).toBe(id)
    expect((await s.call("GET", `/shares/${id}`)).body.title).toBe("Renamed")

    expect((await s.call("DELETE", route, { token: b.token })).status).toBe(404)
    expect((await s.call("DELETE", route, { token: a.token })).status).toBe(204)
    expect((await s.call("GET", `/shares/${id}`)).status).toBe(404)
  })
})
