import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { and, eq, isNull } from "drizzle-orm"
import { Zip } from "@opencode/core/files/zip"
import { fakeCloudflare } from "../../core/test/publish/fake-cloudflare.js"
import { PublishedSiteTable } from "../src/db/schema.js"
import { Publishing, Refusal } from "../src/publishing.js"
import { harness } from "./fixture/setup.js"

const cleanup: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
})

let fake: Awaited<ReturnType<typeof fakeCloudflare>>
const work = { root: "", calls: "", fail: "", slow: "", wrangler: "" }

// The fake wrangler only sees the allowlisted build env plus wrangler's own variables, so its record path and
// switches are baked into the script.
beforeAll(async () => {
  fake = await fakeCloudflare()
  work.root = await mkdtemp(path.join(tmpdir(), "omai-cp-publish-"))
  work.calls = path.join(work.root, "calls.json")
  work.fail = path.join(work.root, "fail")
  work.slow = path.join(work.root, "slow")
  work.wrangler = path.join(work.root, "fake-wrangler.mjs")
  await writeFile(
    work.wrangler,
    `#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import path from "node:path"
const args = process.argv.slice(2)
const config = JSON.parse(readFileSync(args[args.indexOf("--config") + 1], "utf8"))
const list = (dir, prefix = "") =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? list(path.join(dir, entry.name), prefix + entry.name + "/") : [prefix + entry.name],
  )
const root = path.dirname(config.assets.directory)
const file = ${JSON.stringify(work.calls)}
const calls = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : []
calls.push({ args, env: process.env, files: list(root).sort(), config, cwd: process.cwd() })
writeFileSync(file, JSON.stringify(calls))
if (existsSync(${JSON.stringify(work.slow)})) await new Promise((resolve) => setTimeout(resolve, 30_000))
console.log("uploaded")
process.exit(existsSync(${JSON.stringify(work.fail)}) ? 1 : 0)
`,
  )
  await chmod(work.wrangler, 0o755)
})

afterAll(async () => {
  await fake.close()
  await rm(work.root, { recursive: true, force: true })
})

async function calls(): Promise<{ args: string[]; env: Record<string, string>; files: string[]; config: Record<string, unknown>; cwd: string }[]> {
  return existsSync(work.calls) ? JSON.parse(await readFile(work.calls, "utf8")) : []
}

async function setup() {
  const h = await harness()
  cleanup.push(() => h.provider.close())
  await rm(work.calls, { force: true })
  const publishing = Publishing.make({
    db: h.db,
    config: { cloudflare: fake.config, dataDir: h.root, publishMaxBytes: 1024 * 1024, publishConcurrency: 2 },
    env: { OMAI_PUBLISH_WRANGLER: work.wrangler },
  })
  const project = async (userID: string, name: string) => {
    const created = await h.projects.create(userID, name)
    if (typeof created === "string") throw new Error(created)
    return created.id
  }
  return { ...h, publishing, project }
}

/** A zip of `files` (relative path → content) under a `bundle/` top folder, as the VM sends it. */
async function bundle(files: Record<string, string>, extra: Zip.Entry[] = []) {
  const dir = await mkdtemp(path.join(work.root, "bundle-"))
  for (const [name, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, name)), { recursive: true })
    await writeFile(path.join(dir, name), content)
  }
  const scanned = await Zip.scan(dir, "bundle")
  const zip = path.join(dir, "..", `${path.basename(dir)}.zip`)
  await Zip.write([...scanned.entries, ...extra], zip, () => {})
  return zip
}

async function* stream(file: string) {
  yield await readFile(file)
}

async function refusal(promise: Promise<unknown>) {
  return promise.then(
    () => undefined,
    (error: unknown) => (error instanceof Refusal ? error : Promise.reject(error)),
  )
}

const deploy = (s: Awaited<ReturnType<typeof setup>>, projectID: string, zip: string, kind = "nuxt", entry = "index.js", signal = new AbortController().signal) =>
  s.publishing.deploy(projectID, { body: stream(zip), kind, entry, signal })

describe("Publishing", () => {
  test("a name another project owns is taken", async () => {
    const s = await setup()
    const mine = await s.project(s.a, "Shop")
    const theirs = await s.project(s.b, "Blog")
    await s.publishing.claim(mine, s.a, "shop-site")
    expect(await s.publishing.available(theirs, "shop-site")).toEqual({
      available: false,
      reason: "This name is taken. Choose another.",
    })
    expect((await refusal(s.publishing.claim(theirs, s.b, "shop-site")))?.kind).toBe("taken")
    expect(await s.publishing.available(mine, "shop-site")).toEqual({ available: true })
  })

  test("api and admin can't be claimed", async () => {
    const s = await setup()
    const mine = await s.project(s.a, "Shop")
    expect((await s.publishing.available(mine, "api")).available).toBe(false)
    expect((await refusal(s.publishing.claim(mine, s.a, "admin")))?.kind).toBe("invalid")
  })

  test("deploy runs wrangler with the generated config and the token only in its env", async () => {
    const s = await setup()
    const id = await s.project(s.a, "Shop")
    await s.publishing.claim(id, s.a, "shop-deploy")
    const zip = await bundle({ "assets/style.css": "a{}", "worker/index.js": "export default {}", "worker/chunk.js": "" })
    const result = await deploy(s, id, zip)
    expect(result.log).toContain("uploaded")
    const call = (await calls())[0]!
    expect(call.args.slice(0, 5)).toEqual(["deploy", "--dispatch-namespace", "ns", "--name", "shop-deploy"])
    expect(call.env.CLOUDFLARE_API_TOKEN).toBe(fake.config.token)
    expect(call.files).toEqual(["assets/style.css", "worker/chunk.js", "worker/index.js"])
    expect(call.config).toMatchObject({ name: "shop-deploy", no_bundle: true, compatibility_flags: ["nodejs_compat"] })
    expect(String(call.config.main).endsWith("/bundle/worker/index.js")).toBe(true)
    expect((await s.publishing.status(id)).site).toMatchObject({ name: "shop-deploy", kind: "nuxt" })
    // The unpacked upload is gone afterwards.
    expect(existsSync(path.dirname(call.config.main as string))).toBe(false)
  })

  test("an uploaded wrangler.json is ignored", async () => {
    const s = await setup()
    const id = await s.project(s.a, "Shop")
    await s.publishing.claim(id, s.a, "shop-bindings")
    const evil = JSON.stringify({ kv_namespaces: [{ binding: "KV", id: "kv-1" }], services: [{ binding: "D", service: "omai-dispatcher" }] })
    const zip = await bundle({ "wrangler.json": evil, "worker/wrangler.json": evil, "worker/index.js": "", "assets/a.txt": "" })
    await deploy(s, id, zip)
    const call = (await calls())[0]!
    expect(Object.keys(call.config).sort()).toEqual(
      ["assets", "base_dir", "compatibility_date", "compatibility_flags", "find_additional_modules", "main", "name", "no_bundle", "rules"],
    )
    expect(call.config.assets).toEqual({ directory: expect.stringContaining("/bundle/assets"), binding: "ASSETS" })
  })

  test("a zip with a symlink or ../ path deploys nothing", async () => {
    const s = await setup()
    const id = await s.project(s.a, "Shop")
    await s.publishing.claim(id, s.a, "shop-unsafe")
    const outside = path.join(work.root, "secret.txt")
    await writeFile(outside, "secret")
    const linkDir = await mkdtemp(path.join(work.root, "link-"))
    await symlink(outside, path.join(linkDir, "link"))
    const base = { name: "", absolute: outside, type: "file" as const, size: 6, mode: 0o100644, mtime: new Date() }
    const escaping = await bundle({ "worker/index.js": "" }, [{ ...base, name: "../escaped.txt" }])
    const linked = await bundle({ "worker/index.js": "" }, [
      { ...base, name: "bundle/assets/link", absolute: path.join(linkDir, "link"), type: "link", size: 0, mode: 0o120777 },
    ])
    expect((await refusal(deploy(s, id, escaping)))?.kind).toBe("invalid")
    // A failed first deploy released the name, so claim it again for the second try.
    await s.publishing.claim(id, s.a, "shop-unsafe")
    expect((await refusal(deploy(s, id, linked)))?.kind).toBe("invalid")
    expect(await calls()).toEqual([])
    expect(existsSync(path.join(s.root, "escaped.txt"))).toBe(false)
  })

  test("an upload over the limit is refused", async () => {
    const s = await setup()
    const id = await s.project(s.a, "Shop")
    await s.publishing.claim(id, s.a, "shop-large")
    const big = path.join(work.root, "big.bin")
    await writeFile(big, Buffer.alloc(2 * 1024 * 1024, 1))
    expect((await refusal(deploy(s, id, big)))?.kind).toBe("limit")
    expect(await calls()).toEqual([])
  })

  test("a second deploy for the same project is refused while one runs", async () => {
    const s = await setup()
    const id = await s.project(s.a, "Shop")
    await s.publishing.claim(id, s.a, "shop-busy")
    const zip = await bundle({ "worker/index.js": "" })
    await writeFile(work.slow, "")
    cleanup.push(() => rm(work.slow, { force: true }))
    const abort = new AbortController()
    const first = refusal(deploy(s, id, zip, "nuxt", "index.js", abort.signal))
    while ((await calls()).length === 0) await Bun.sleep(20)
    expect((await refusal(deploy(s, id, zip)))?.kind).toBe("busy")
    abort.abort()
    await first
  })

  test("closing the request stops wrangler and a failed first deploy releases the name", async () => {
    const s = await setup()
    const id = await s.project(s.a, "Shop")
    await s.publishing.claim(id, s.a, "shop-cancel")
    const zip = await bundle({ "worker/index.js": "" })
    await writeFile(work.slow, "")
    cleanup.push(() => rm(work.slow, { force: true }))
    const abort = new AbortController()
    const started = Date.now()
    const pending = refusal(deploy(s, id, zip, "nuxt", "index.js", abort.signal))
    while ((await calls()).length === 0) await Bun.sleep(20)
    abort.abort()
    const failed = await pending
    expect(failed?.message).toBe("The publish was cancelled.")
    expect(Date.now() - started).toBeLessThan(10_000)
    expect((await s.publishing.status(id)).site).toBeUndefined()
    expect(fake.state.scripts.has("shop-cancel")).toBe(false)
  })

  test("a release while a deploy runs changes nothing", async () => {
    const s = await setup()
    const id = await s.project(s.a, "Shop")
    await s.publishing.claim(id, s.a, "shop-race")
    await writeFile(work.slow, "")
    const pending = deploy(s, id, await bundle({ "assets/index.html": "hi" }), "static")
    while ((await calls()).length === 0) await Bun.sleep(20)
    expect((await refusal(s.publishing.release(id)))?.kind).toBe("busy")
    expect((await s.publishing.status(id)).site?.name).toBe("shop-race")
    // The upload then goes live: the site stays recorded.
    await rm(work.slow, { force: true })
    await pending.catch(() => undefined)
  }, 40_000)

  test("a deploy waiting too long for a free slot is refused as busy", async () => {
    const s = await setup()
    const narrow = Publishing.make({
      db: s.db,
      config: { cloudflare: fake.config, dataDir: s.root, publishMaxBytes: 1024 * 1024, publishConcurrency: 1 },
      env: { OMAI_PUBLISH_WRANGLER: work.wrangler },
      queueWaitMs: 300,
    })
    const first = await s.project(s.a, "First")
    const second = await s.project(s.a, "Second")
    await narrow.claim(first, s.a, "shop-slot-1")
    await narrow.claim(second, s.a, "shop-slot-2")
    const zip = await bundle({ "assets/index.html": "hi" })
    await writeFile(work.slow, "")
    cleanup.push(() => rm(work.slow, { force: true }))
    const abort = new AbortController()
    const running = refusal(narrow.deploy(first, { body: stream(zip), kind: "static", signal: abort.signal }))
    while ((await calls()).length === 0) await Bun.sleep(20)
    const waited = await refusal(narrow.deploy(second, { body: stream(zip), kind: "static", signal: new AbortController().signal }))
    expect(waited?.kind).toBe("busy")
    abort.abort()
    await running
  })

  test("a failed upload keeps a live site and releases a first one", async () => {
    const s = await setup()
    const id = await s.project(s.a, "Shop")
    await s.publishing.claim(id, s.a, "shop-fail")
    const zip = await bundle({ "assets/index.html": "hi" })
    await deploy(s, id, zip, "static")
    await writeFile(work.fail, "")
    cleanup.push(() => rm(work.fail, { force: true }))
    const live = await refusal(deploy(s, id, zip, "static"))
    expect(live?.message).toBe("The upload to Cloudflare failed. The previous version is still live.")
    expect((await s.publishing.status(id)).site?.name).toBe("shop-fail")

    const other = await s.project(s.a, "Other")
    await s.publishing.claim(other, s.a, "shop-first")
    const first = await refusal(deploy(s, other, zip, "static"))
    expect(first?.message).toBe("The upload to Cloudflare failed. Nothing was published.")
    expect(first?.log).toContain("uploaded")
    expect((await s.publishing.status(other)).site).toBeUndefined()
    expect(await s.publishing.available(id, "shop-first")).toEqual({ available: true })
  })

  test("remove deletes only our script, keys and hostnames, and frees the name", async () => {
    const s = await setup()
    const id = await s.project(s.a, "Shop")
    await s.publishing.claim(id, s.a, "shop-remove")
    await deploy(s, id, await bundle({ "assets/index.html": "hi" }), "static")
    fake.state.scripts.set("someone-else", [])
    fake.state.kv.set("other.example", "someone-else")
    expect((await refusal(s.publishing.remove(id, "wrong")))?.kind).toBe("invalid")
    await s.publishing.remove(id, "shop-remove")
    expect(fake.state.scripts.has("shop-remove")).toBe(false)
    expect(fake.state.scripts.has("someone-else")).toBe(true)
    expect(fake.state.kv.get("other.example")).toBe("someone-else")
    const live = await s.db
      .select()
      .from(PublishedSiteTable)
      .where(and(eq(PublishedSiteTable.project_id, id), isNull(PublishedSiteTable.deleted_at)))
    expect(live).toEqual([])
    // Soft deleted: the row stays, and the name can be claimed again.
    expect((await s.db.select().from(PublishedSiteTable).where(eq(PublishedSiteTable.project_id, id))).length).toBe(1)
    expect(await s.publishing.available(id, "shop-remove")).toEqual({ available: true })
  })
})
