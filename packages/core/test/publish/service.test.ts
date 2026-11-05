import { afterAll, beforeAll, describe, expect } from "bun:test"
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { eq } from "drizzle-orm"
import { randomUUID } from "node:crypto"
import { Effect, Exit, Layer } from "effect"
import { Database } from "@opencode/core/database/database"
import { PublishService } from "@opencode/core/publish/service"
import { PublishDeployTable, PublishDomainTable, PublishSiteTable } from "@opencode/core/publish/sql"
import { Global } from "@opencode/util/global"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { tmpdir } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"
import { fakeCloudflare } from "./fake-cloudflare"

type Call = { args: string[]; env: Record<string, string>; assets: string[]; config: { assets?: { directory: string } } }

const saved = { ...process.env }
let fake: Awaited<ReturnType<typeof fakeCloudflare>>
let root: Awaited<ReturnType<typeof tmpdir>>
// The fake wrangler and the fixture scripts only see the allowlisted build env, so their record paths and the upload
// failure switch are baked into the scripts and files instead of passed as variables.
const paths = {
  data: "",
  calls: "",
  failUpload: "",
  records: "",
}

beforeAll(async () => {
  fake = await fakeCloudflare()
  root = await tmpdir("omai-publish-service-")
  paths.data = path.join(root.path, "data")
  paths.calls = path.join(root.path, "wrangler-calls.json")
  paths.failUpload = path.join(root.path, "fail-upload")
  paths.records = path.join(root.path, "records")
  const wrangler = path.join(root.path, "fake-wrangler.mjs")
  await writeFile(
    wrangler,
    `#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import path from "node:path"
const args = process.argv.slice(2)
const config = JSON.parse(readFileSync(args[args.indexOf("--config") + 1], "utf8"))
const list = (dir, prefix = "") =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? list(path.join(dir, entry.name), prefix + entry.name + "/") : [prefix + entry.name],
  )
const assets = config.assets && existsSync(config.assets.directory) ? list(config.assets.directory).sort() : []
const file = ${JSON.stringify(paths.calls)}
const calls = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : []
calls.push({ args, env: process.env, assets, config })
writeFileSync(file, JSON.stringify(calls))
process.exit(existsSync(${JSON.stringify(paths.failUpload)}) ? 1 : 0)
`,
  )
  await chmod(wrangler, 0o755)
  Object.assign(process.env, {
    OMAI_CLOUDFLARE_ACCOUNT_ID: fake.config.accountID,
    OMAI_CLOUDFLARE_API_TOKEN: fake.config.token,
    OMAI_CLOUDFLARE_PLATFORM_ZONE: fake.config.zone,
    OMAI_CLOUDFLARE_DISPATCH_NAMESPACE: "omai-apps",
    OMAI_CLOUDFLARE_API_BASE: fake.config.api,
    OMAI_PUBLISH_WRANGLER: wrangler,
    OMAI_TEST_SECRET: "provider-key",
  })
})

afterAll(async () => {
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]
  Object.assign(process.env, saved)
  await fake.close()
  await root[Symbol.asyncDispose]()
})

const it = testEffect(
  LayerNode.compile(LayerNode.group([PublishService.node, Database.node]), {
    // The data directory is created in beforeAll, after this layer is defined.
    replacements: [Global.node.replace(Layer.unwrap(Effect.sync(() => Global.layerWith({ data: paths.data }))))],
  }),
)

const calls = async (): Promise<Call[]> =>
  JSON.parse(await readFile(paths.calls, "utf8").catch(() => "[]"))

const record = async (label: string): Promise<Record<string, string>> =>
  JSON.parse(await readFile(path.join(paths.records, `${label}.json`), "utf8"))

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

// The script records its own env and argv so tests can check what install and build saw.
const recorder = (label: string) =>
  `const fs = require("node:fs"); fs.mkdirSync(${JSON.stringify(paths.records)}, { recursive: true }); ` +
  `fs.writeFileSync(${JSON.stringify(paths.records)} + "/" + ${JSON.stringify(label)} + ".json", JSON.stringify(process.env));`

const buildPackage = (build: string) =>
  JSON.stringify({
    name: "fixture",
    version: "1.0.0",
    private: true,
    scripts: { dev: "vite", build, postinstall: "node record-install.js" },
  })

const buildSite = (label: string, build = "node build.js") =>
  project({
    "package.json": buildPackage(build),
    "vite.config.js": "export default {}\n",
    "record-install.js": recorder(`${label}-install`),
    "build.js":
      recorder(`${label}-build`) +
      ` fs.mkdirSync("dist", { recursive: true }); fs.writeFileSync("dist/index.html", "<h1>built</h1>");`,
  })

const settle = Effect.fnUntraced(function* (projectID: string, directory: string) {
  const service = yield* PublishService.Service
  for (let index = 0; index < 400; index++) {
    const status = yield* service.status(projectID, directory)
    if (!status.running) return status
    yield* Effect.sleep("50 millis")
  }
  throw new Error("the publish did not finish")
})

describe("PublishService", () => {
  it.live(
    "first publish of a static site goes live and records the site",
    () =>
      Effect.gen(function* () {
        const service = yield* PublishService.Service
        const db = (yield* Database.Service).db
        const directory = yield* Effect.promise(staticSite)
        const before = (yield* Effect.promise(calls)).length

        expect(yield* service.available("prj_static", "my-site")).toEqual({ available: true })
        const deploy = yield* service.publish({ projectID: "prj_static", directory, name: "my-site" })
        expect(deploy.status).toBe("running")
        const status = yield* settle("prj_static", directory)

        expect(status.history[0]?.id).toBe(deploy.id)
        expect(status.history[0]?.status).toBe("live")
        expect(status.history[0]?.kind).toBe("static")
        expect(status.site?.name).toBe("my-site")
        expect(status.site?.url).toBe("https://my-site.omai.test")
        expect(status.site?.kind).toBe("static")
        expect(status.site?.publishedAt).toBeNumber()
        const call = (yield* Effect.promise(calls))[before]
        expect(call?.args.join(" ")).toContain("--dispatch-namespace omai-apps --name my-site")
        expect(call?.args[0]).toBe("deploy")
        expect(call?.assets).toEqual(["assets/app.css", "index.html"])
        expect(call?.env.CLOUDFLARE_API_TOKEN).toBe(fake.config.token)
        expect(call?.env.CLOUDFLARE_ACCOUNT_ID).toBe(fake.config.accountID)
        expect(call?.env.OMAI_CLOUDFLARE_API_TOKEN).toBeUndefined()
        expect(call?.env.OMAI_TEST_SECRET).toBeUndefined()
        expect(fake.state.scripts.get("my-site")).toEqual(["omai-project-prj_static"])
        // The user's project is never written.
        expect((yield* Effect.promise(() => readFile(path.join(directory, "index.html"), "utf8")))).toBe("<h1>hi</h1>")
        const site = yield* db.select().from(PublishSiteTable).where(eq(PublishSiteTable.project_id, "prj_static")).get().pipe(Effect.orDie)
        expect(site?.time_published).toBeNumber()
        // Another project can't take the name now.
        expect((yield* service.available("prj_other", "my-site")).available).toBe(false)
        expect((yield* service.available("prj_static", "my-site")).available).toBe(true)
      }),
    30_000,
  )

  it.live(
    "publish while running joins the running deploy",
    () =>
      Effect.gen(function* () {
        const service = yield* PublishService.Service
        const directory = yield* Effect.promise(staticSite)
        const before = (yield* Effect.promise(calls)).length

        const both = yield* Effect.all(
          [
            service.publish({ projectID: "prj_join", directory, name: "join-site" }),
            service.publish({ projectID: "prj_join", directory, name: "join-site" }),
          ],
          { concurrency: "unbounded" },
        )
        const third = yield* service.publish({ projectID: "prj_join", directory })
        expect(both[0].id).toBe(both[1].id)
        expect(third.id).toBe(both[0].id)
        const status = yield* settle("prj_join", directory)

        expect(status.history.map((item) => item.status)).toEqual(["live"])
        expect((yield* Effect.promise(calls)).length - before).toBe(1)
      }),
    30_000,
  )

  it.live(
    "a failed build leaves the live deploy alone",
    () =>
      Effect.gen(function* () {
        const service = yield* PublishService.Service
        const directory = yield* Effect.promise(() => buildSite("fail-build"))
        const before = (yield* Effect.promise(calls)).length

        yield* service.publish({ projectID: "prj_build", directory, name: "build-site" })
        const live = yield* settle("prj_build", directory)
        expect(live.history[0]?.status).toBe("live")
        expect(live.site?.kind).toBe("spa")
        const call = (yield* Effect.promise(calls))[before]
        // Wrangler reads `.assetsignore` and never uploads it.
        expect(call?.assets).toEqual([".assetsignore", "index.html"])
        expect(call?.config.assets?.directory.endsWith(path.join("stage", "dist"))).toBe(true)

        // Install keeps devDependencies (no NODE_ENV); only the build is production. Neither sees a secret.
        const install = yield* Effect.promise(() => record("fail-build-install"))
        const build = yield* Effect.promise(() => record("fail-build-build"))
        expect(install.NODE_ENV).toBeUndefined()
        expect(install.CI).toBe("1")
        expect(build.NODE_ENV).toBe("production")
        expect(build.CI).toBe("1")
        for (const env of [install, build]) {
          expect(Object.keys(env).filter((key) => key.startsWith("OMAI_") || key.startsWith("CLOUDFLARE_"))).toEqual([])
          expect(Object.values(env)).not.toContain(fake.config.token)
        }

        yield* Effect.promise(() =>
          writeFile(path.join(directory, "package.json"), buildPackage("exit 1")),
        )
        yield* service.publish({ projectID: "prj_build", directory })
        const failed = yield* settle("prj_build", directory)

        expect(failed.history.map((item) => item.status)).toEqual(["failed", "live"])
        expect(failed.history[0]?.error).toBe("`npm run build` failed with exit code 1.")
        expect(failed.site?.publishedAt).toBe(live.site?.publishedAt)
        expect(fake.state.scripts.has("build-site")).toBe(true)
        expect((yield* service.log("prj_build", failed.history[0]?.id ?? "")).length).toBeGreaterThan(0)
        expect((yield* Effect.promise(calls)).length - before).toBe(1)
      }),
    60_000,
  )

  it.live(
    "a failed first publish releases the claimed name",
    () =>
      Effect.gen(function* () {
        const service = yield* PublishService.Service
        const db = (yield* Database.Service).db
        const directory = yield* Effect.promise(staticSite)

        yield* Effect.promise(() => writeFile(paths.failUpload, ""))
        yield* service.publish({ projectID: "prj_first", directory, name: "first-site" })
        const status = yield* settle("prj_first", directory).pipe(
          Effect.ensuring(Effect.promise(() => rm(paths.failUpload, { force: true }))),
        )

        expect(status.history[0]?.status).toBe("failed")
        expect(status.history[0]?.error).toBeString()
        expect(status.site).toBeUndefined()
        expect(fake.state.scripts.has("first-site")).toBe(false)
        expect(yield* db.select().from(PublishSiteTable).all().pipe(Effect.orDie)).toEqual([])
        expect(yield* service.available("prj_someone", "first-site")).toEqual({ available: true })
      }),
    30_000,
  )

  it.live(
    "a failed republish never deletes the live script",
    () =>
      Effect.gen(function* () {
        const service = yield* PublishService.Service
        const directory = yield* Effect.promise(staticSite)

        yield* service.publish({ projectID: "prj_reup", directory, name: "reup-site" })
        const live = yield* settle("prj_reup", directory)
        yield* Effect.promise(() => writeFile(paths.failUpload, ""))
        yield* service.publish({ projectID: "prj_reup", directory })
        const failed = yield* settle("prj_reup", directory).pipe(
          Effect.ensuring(Effect.promise(() => rm(paths.failUpload, { force: true }))),
        )

        expect(failed.history.map((item) => item.status)).toEqual(["failed", "live"])
        expect(failed.site?.publishedAt).toBe(live.site?.publishedAt)
        expect(fake.state.scripts.has("reup-site")).toBe(true)
      }),
    30_000,
  )

  it.live(
    "remove requires the exact site name",
    () =>
      Effect.gen(function* () {
        const service = yield* PublishService.Service
        const db = (yield* Database.Service).db
        const directory = yield* Effect.promise(staticSite)

        yield* service.publish({ projectID: "prj_remove", directory, name: "gone-site" })
        yield* settle("prj_remove", directory)
        const now = Date.now()
        yield* db
          .insert(PublishDomainTable)
          .values([
            { hostname: "gone.example", project_id: "prj_remove", cf_id: "ch-gone", is_primary: true, status: "active", ssl: "active", time_created: now, time_updated: now },
            // A row whose Cloudflare create never answered: the hostname now in Cloudflare was never ours.
            { hostname: "unrecorded.example", project_id: "prj_remove", is_primary: false, status: "pending", ssl: "pending", time_created: now, time_updated: now },
          ])
          .run()
          .pipe(Effect.orDie)
        fake.state.hostnames.set("gone.example", { id: "ch-gone", hostname: "gone.example", status: "active", ssl: { status: "active" } })
        fake.state.hostnames.set("keep.example", { id: "ch-keep", hostname: "keep.example", status: "active", ssl: { status: "active" } })
        fake.state.hostnames.set("unrecorded.example", { id: "ch-unrecorded", hostname: "unrecorded.example", status: "active", ssl: { status: "active" } })
        fake.state.kv.set("gone.example", JSON.stringify({ script: "gone-site" }))
        fake.state.kv.set("gone-site.omai.test", JSON.stringify({ redirect: "gone.example" }))
        fake.state.kv.set("keep.example", "old-project-site")

        const wrong = yield* service.remove("prj_remove", "gone").pipe(Effect.exit)
        expect(Exit.isFailure(wrong)).toBe(true)
        expect(fake.state.scripts.has("gone-site")).toBe(true)

        const requests = fake.state.requests.length
        yield* service.remove("prj_remove", "gone-site")
        expect(fake.state.scripts.has("gone-site")).toBe(false)
        expect(fake.state.kv.has("gone.example")).toBe(false)
        expect(fake.state.kv.has("gone-site.omai.test")).toBe(false)
        expect(fake.state.kv.get("keep.example")).toBe("old-project-site")
        expect(fake.state.hostnames.has("gone.example")).toBe(false)
        expect(fake.state.hostnames.has("keep.example")).toBe(true)
        expect(fake.state.hostnames.get("unrecorded.example")?.id).toBe("ch-unrecorded")
        expect(fake.state.requests.slice(requests).some((request) => request.method === "GET" && request.path.endsWith("/custom_hostnames"))).toBe(false)
        expect(yield* db.select().from(PublishSiteTable).all().pipe(Effect.orDie)).toEqual([])
        expect(yield* db.select().from(PublishDomainTable).all().pipe(Effect.orDie)).toEqual([])
        expect(yield* db.select().from(PublishDeployTable).all().pipe(Effect.orDie)).toEqual([])
        const after = yield* service.status("prj_remove", directory)
        expect(after.site).toBeUndefined()
        // The zone is reported without a site, so the panel can show the address suffix before the first publish.
        expect(after.zone).toBe(fake.config.zone)
      }),
    30_000,
  )

  it.live(
    "cancel stops a running build",
    () =>
      Effect.gen(function* () {
        const service = yield* PublishService.Service
        const directory = yield* Effect.promise(() => buildSite("cancel", "sleep 30"))

        yield* service.publish({ projectID: "prj_cancel", directory, name: "cancel-site" })
        for (let index = 0; index < 400; index++) {
          const status = yield* service.status("prj_cancel", directory)
          if (status.running?.stage === "build") break
          yield* Effect.sleep("50 millis")
        }
        const started = Date.now()
        yield* service.cancel("prj_cancel")
        expect(Date.now() - started).toBeLessThan(5_000)
        const status = yield* service.status("prj_cancel", directory)

        expect(status.running).toBeUndefined()
        expect(status.history[0]?.status).toBe("cancelled")
        expect(status.site).toBeUndefined()
        expect(fake.state.scripts.has("cancel-site")).toBe(false)
      }),
    60_000,
  )

  it.live(
    "a busy name is not available",
    () =>
      Effect.gen(function* () {
        const service = yield* PublishService.Service
        fake.state.scripts.set("old-app", [])
        fake.state.records.set("dns-app.omai.test", "A")

        expect((yield* service.available("prj_names", "old-app")).available).toBe(false)
        expect((yield* service.available("prj_names", "dns-app")).available).toBe(false)
        expect((yield* service.available("prj_names", "www")).available).toBe(false)
        expect((yield* service.available("prj_names", "Bad Name")).available).toBe(false)
        const taken = yield* service.publish({ projectID: "prj_names", directory: root.path, name: "old-app" }).pipe(Effect.exit)
        expect(Exit.isFailure(taken)).toBe(true)
        expect(fake.state.scripts.get("old-app")).toEqual([])
      }),
    30_000,
  )
})
