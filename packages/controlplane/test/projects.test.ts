import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { eq } from "drizzle-orm"
import { SignedToken } from "@opencode/util/signed-token"
import { Database } from "../src/db/database.js"
import { ProjectTable } from "../src/db/schema.js"
import { Projects, slugify } from "../src/projects.js"
import { Users } from "../src/users.js"
import { LocalVmProvider } from "../src/vm/local.js"
import { exitingVmCommand, fakeVmCommand, testConfig, until } from "./fixture/setup.js"

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((fn) => fn()))
})

async function setup(env: Record<string, string> = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "omai-cp-"))
  const config = testConfig({ OMAI_LOCAL_PROJECTS_ROOT: root, OMAI_LOCAL_SERVE_COMMAND: fakeVmCommand, ...env })
  const db = await Database.memory()
  const provider = LocalVmProvider.make(config)
  cleanup.push(() => provider.close())
  const projects = Projects.make(db, config, provider)
  const a = await Users.create(db, { username: "a", email: "a@x.y", password: "p" })
  const b = await Users.create(db, { username: "b", email: "b@x.y", password: "p" })
  return { db, config, projects, provider, a: a.id, b: b.id, root }
}

function view<T>(value: T) {
  if (typeof value === "string" || value === undefined) throw new Error(`expected a project, got ${value}`)
  return value as Exclude<T, string | undefined>
}

describe("slugify", () => {
  test("slugify", () => {
    expect(slugify("My Shop!")).toBe("my-shop")
    expect(slugify("  ")).toBe("project")
    expect(slugify("Ünïcode Name")).toMatch(/^[a-z0-9-]+$/)
    expect(slugify("x".repeat(100))).toHaveLength(48)
    expect(slugify("--a--b--")).toBe("a-b")
  })
})

describe("Projects", () => {
  test("same name twice at once", async () => {
    const s = await setup()
    const results = await Promise.all([s.projects.create(s.a, "Shop"), s.projects.create(s.a, "shop")])
    expect(results.filter((r) => r === "exists")).toHaveLength(1)
    expect(results.filter((r) => typeof r === "object")).toHaveLength(1)
  })

  test("invalid names", async () => {
    const s = await setup()
    expect(await s.projects.create(s.a, "   ")).toBe("invalid")
    expect(await s.projects.create(s.a, "x".repeat(65))).toBe("invalid")
  })

  test("isolation", async () => {
    const s = await setup()
    const project = view(await s.projects.create(s.a, "Shop"))
    await until(
      () => s.projects.get(s.a, project.id),
      (p) => p?.vmState === "running",
    )
    const before = (await s.db.select().from(ProjectTable).where(eq(ProjectTable.id, project.id)))[0]
    expect(await s.projects.get(s.b, project.id)).toBeUndefined()
    expect(await s.projects.rename(s.b, project.id, "Mine")).toBeUndefined()
    expect(await s.projects.remove(s.b, project.id)).toBe(false)
    expect(await s.projects.open(s.b, "sid", project.id)).toBeUndefined()
    expect(await s.projects.retry(s.b, project.id)).toBeUndefined()
    expect(await s.projects.list(s.b)).toEqual([])
    const after = (await s.db.select().from(ProjectTable).where(eq(ProjectTable.id, project.id)))[0]
    expect(after).toEqual(before)
  })

  test("rename keeps the slug", async () => {
    const s = await setup()
    const project = view(await s.projects.create(s.a, "Shop"))
    const renamed = view(await s.projects.rename(s.a, project.id, "Store"))
    expect(renamed.name).toBe("Store")
    expect(renamed.slug).toBe("shop")
    await s.projects.create(s.a, "Blog")
    expect(await s.projects.rename(s.a, project.id, "blog")).toBe("exists")
  })

  test("soft delete hides and frees the name", async () => {
    const s = await setup()
    const project = view(await s.projects.create(s.a, "Shop"))
    expect(await s.projects.remove(s.a, project.id)).toBe(true)
    expect(await s.projects.list(s.a)).toEqual([])
    expect(await s.projects.get(s.a, project.id)).toBeUndefined()
    const row = (await s.db.select().from(ProjectTable).where(eq(ProjectTable.id, project.id)))[0]
    expect(row?.deleted_at).toBeInstanceOf(Date)
    view(await s.projects.create(s.a, "Shop"))
  })

  test("deleted project cannot be opened", async () => {
    const s = await setup()
    const project = view(await s.projects.create(s.a, "Shop"))
    await until(
      () => s.projects.get(s.a, project.id),
      (p) => p?.vmState === "running",
    )
    await s.projects.remove(s.a, project.id)
    expect(await s.projects.open(s.a, "sid", project.id)).toBeUndefined()
  })

  test("provision reaches running and open returns a token for that project", async () => {
    const s = await setup()
    const project = view(await s.projects.create(s.a, "My Shop"))
    expect(project.vmState).toBe("creating")
    await until(
      () => s.projects.get(s.a, project.id),
      (p) => p?.vmState === "running",
    )
    const opened = await s.projects.open(s.a, "sid-1", project.id)
    if (!opened || opened === "not-ready") throw new Error("expected open")
    expect(opened.routerUrl).toBe(`http://router.test/vm/${project.id}`)
    expect(opened.directory).toBe(path.join(s.root, project.id, "home", "my-shop"))
    const claims = SignedToken.verify(opened.token, s.config.publicKey)
    expect(claims?.typ === "vm" && claims.pid).toBe(project.id)
    expect(claims?.sid).toBe("sid-1")
  })

  test("local provider env is allowlisted", async () => {
    const s = await setup()
    const project = view(await s.projects.create(s.a, "Shop"))
    await until(
      () => s.projects.get(s.a, project.id),
      (p) => p?.vmState === "running",
    )
    const row = (await s.db.select().from(ProjectTable).where(eq(ProjectTable.id, project.id)))[0]!
    const names: string[] = await fetch(`${row.vm_host}/env`).then((r) => r.json())
    expect(names).toContain("OMAI_PROJECT_ID")
    expect(names).toContain("OMAI_PROJECT_TOKEN")
    expect(names).toContain("HOME")
    const allowed = new Set(["PATH", "HOME", "OMAI_PROJECTS_HOME"])
    const leaked = names.filter((name) => !allowed.has(name) && !name.startsWith("OMAI_PROJECT") && name in process.env)
    expect(leaked).toEqual([])
    expect(names).not.toContain("OMAI_TOKEN_SIGNING_KEY")
  })

  test("a restarted VM keeps working after its process is gone", async () => {
    const s = await setup()
    const project = view(await s.projects.create(s.a, "Shop"))
    await until(
      () => s.projects.get(s.a, project.id),
      (p) => p?.vmState === "running",
    )
    await s.provider.close()
    const opened = await s.projects.open(s.a, "sid", project.id)
    if (!opened || opened === "not-ready") throw new Error("expected open")
    const host = (SignedToken.verify(opened.token, s.config.publicKey) as SignedToken.VmClaims).host
    expect((await fetch(`${host}/api/info`)).status).toBe(200)
  })

  test("provision fails cleanly and retry starts again", async () => {
    const s = await setup({ OMAI_LOCAL_SERVE_COMMAND: exitingVmCommand, OMAI_VM_WAKE_TIMEOUT_MS: "1500" })
    const project = view(await s.projects.create(s.a, "Shop"))
    const failed = await until(
      () => s.projects.get(s.a, project.id),
      (p) => p?.vmState === "failed",
    )
    expect(failed?.vmError).toBeTruthy()
    expect(await s.projects.open(s.a, "sid", project.id)).toBe("not-ready")
    expect((await s.projects.retry(s.a, project.id))?.vmState).toBe("creating")
    await until(
      () => s.projects.get(s.a, project.id),
      (p) => p?.vmState === "failed",
    )
  })

  test("project tokens and summaries", async () => {
    const s = await setup()
    const project = view(await s.projects.create(s.a, "Shop"))
    await until(
      () => s.projects.get(s.a, project.id),
      (p) => p?.vmState === "running",
    )
    const row = (await s.db.select().from(ProjectTable).where(eq(ProjectTable.id, project.id)))[0]!
    const names: string[] = await fetch(`${row.vm_host}/env`).then((r) => r.json())
    expect(names).toContain("OMAI_PROJECT_TOKEN")
    expect(await s.projects.verifyProjectToken(project.id, "wrong")).toBe(false)
    const token = await fetch(`${row.vm_host}/token`).then((r) => r.text())
    expect(await s.projects.verifyProjectToken(project.id, token)).toBe(true)
    await s.projects.setSummary(project.id, { title: "Checkout page", at: 1_700_000_000_000 })
    expect((await s.projects.get(s.a, project.id))?.lastSession).toEqual({
      title: "Checkout page",
      at: 1_700_000_000_000,
    })
  })
})
