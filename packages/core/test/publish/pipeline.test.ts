import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { chmod, mkdir, readdir, readFile, realpath, writeFile } from "node:fs/promises"
import path from "node:path"
import { randomUUID } from "node:crypto"
import type { Publish } from "@opencode/schema/publish"
import { PublishPipeline } from "../../src/publish/pipeline"
import { tmpdir } from "../fixture/tmpdir"

type Call = {
  config: { main?: string; assets: { directory: string } }
  assets: string[]
  ignore?: string
}

const saved = process.env.OMAI_PUBLISH_WRANGLER
let root: Awaited<ReturnType<typeof tmpdir>>
const paths = { data: "", calls: "", wrangler: "", slow: "", failing: "", cwd: "" }

const config = {
  accountID: "account",
  token: "token",
  zone: "omai.test",
  namespace: "omai-apps",
  apexIPs: [],
  api: "http://127.0.0.1:1",
}

beforeAll(async () => {
  root = await tmpdir("omai-publish-pipeline-")
  paths.data = path.join(root.path, "data")
  paths.calls = path.join(root.path, "calls.json")
  paths.wrangler = path.join(root.path, "fake-wrangler.cjs")
  paths.slow = path.join(root.path, "slow-wrangler.cjs")
  paths.failing = path.join(root.path, "failing-wrangler.cjs")
  paths.cwd = path.join(root.path, "cwd.txt")
  // Records the generated config, the files in its assets directory and the `.assetsignore` there.
  await writeFile(
    paths.wrangler,
    `#!/usr/bin/env node
const fs = require("node:fs")
const path = require("node:path")
const args = process.argv.slice(2)
const config = JSON.parse(fs.readFileSync(args[args.indexOf("--config") + 1], "utf8"))
const list = (dir, prefix = "") =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? list(path.join(dir, entry.name), prefix + entry.name + "/") : [prefix + entry.name],
  )
const ignore = path.join(config.assets.directory, ".assetsignore")
const file = ${JSON.stringify(paths.calls)}
const calls = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : []
calls.push({ config, assets: list(config.assets.directory).sort(), ignore: fs.existsSync(ignore) ? fs.readFileSync(ignore, "utf8") : undefined })
fs.writeFileSync(file, JSON.stringify(calls))
`,
  )
  // Finishes the upload, then gets the cancel's SIGTERM and still exits 0, as a real upload finishing at that moment.
  await writeFile(
    paths.slow,
    `#!/usr/bin/env node
process.on("SIGTERM", () => setTimeout(() => process.exit(0), 50))
console.log("Uploaded the new version")
setTimeout(() => process.exit(0), 10_000)
`,
  )
  // Records the directory it runs in, then fails the upload.
  await writeFile(
    paths.failing,
    `#!/usr/bin/env node
require("node:fs").writeFileSync(${JSON.stringify(paths.cwd)}, process.cwd())
process.exit(1)
`,
  )
  await chmod(paths.wrangler, 0o755)
  await chmod(paths.slow, 0o755)
  await chmod(paths.failing, 0o755)
})

afterAll(async () => {
  if (saved === undefined) delete process.env.OMAI_PUBLISH_WRANGLER
  if (saved !== undefined) process.env.OMAI_PUBLISH_WRANGLER = saved
  await root[Symbol.asyncDispose]()
})

async function project(files: Record<string, string>) {
  const dir = path.join(root.path, "projects", randomUUID())
  await write(dir, files)
  return dir
}

async function write(dir: string, files: Record<string, string>) {
  await Promise.all(
    Object.entries(files).map(async (entry) => {
      await mkdir(path.dirname(path.join(dir, entry[0])), { recursive: true })
      await writeFile(path.join(dir, entry[0]), entry[1])
    }),
  )
}

const calls = async (): Promise<Call[]> => JSON.parse(await readFile(paths.calls, "utf8").catch(() => "[]"))

function run(input: {
  projectID: string
  directory: string
  wrangler?: string
  signal?: AbortSignal
  first?: boolean
  onLog?: (chunk: string) => void
}) {
  process.env.OMAI_PUBLISH_WRANGLER = input.wrangler ?? paths.wrangler
  return PublishPipeline.run({
    projectID: input.projectID,
    directory: input.directory,
    dataDir: paths.data,
    name: "site",
    upload: { config },
    first: input.first,
    signal: input.signal ?? new AbortController().signal,
    onStage: () => {},
    onLog: input.onLog ?? (() => {}),
  })
}

const failure = (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (error: unknown) => (error instanceof PublishPipeline.PublishFailure ? error.message : String(error)),
  )

// A build script writing these files into the stage. Installs stay offline: every package is a local `file:` stub.
const builder = (files: Record<string, string>) =>
  `const fs = require("node:fs"); const path = require("node:path");\n` +
  `for (const [file, text] of Object.entries(${JSON.stringify(files)})) {\n` +
  `  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text)\n}\n`

const stub = (name: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ name, version: "0.0.0", ...extra })

type Case = {
  kind: Publish.Kind
  files: Record<string, string>
  dependencies: Record<string, string>
  main: string
  assets: string
  /** What the incomplete build leaves out, so the check names it. */
  missing: string
}

const cases: Case[] = [
  {
    kind: "next",
    files: {
      "next.config.js": "module.exports = {}\n",
      "vendor/opennext/package.json": stub("@opennextjs/cloudflare", { bin: { "opennextjs-cloudflare": "cli.js" } }),
      // The adapter replaces the build command; its stub runs the fixture's build script.
      "vendor/opennext/cli.js": `#!/usr/bin/env node\nrequire(require("node:path").join(process.cwd(), "build.js"))\n`,
      "vendor/wrangler/package.json": stub("wrangler"),
    },
    dependencies: { "@opennextjs/cloudflare": "file:./vendor/opennext", wrangler: "file:./vendor/wrangler" },
    main: ".open-next/worker.js",
    assets: ".open-next/assets",
    missing: ".open-next/worker.js",
  },
  {
    kind: "nuxt",
    files: { "nuxt.config.ts": "export default {}\n" },
    dependencies: {},
    main: ".output/server/index.mjs",
    assets: ".output/public",
    missing: ".output/server/index.mjs",
  },
  {
    kind: "solidstart",
    files: { "vendor/start/package.json": stub("@solidjs/start") },
    dependencies: { "@solidjs/start": "file:./vendor/start" },
    main: ".output/server/index.mjs",
    assets: ".output/public",
    missing: ".output/server/index.mjs",
  },
  {
    kind: "sveltekit",
    files: {
      "vite.config.js": `import adapter from "@sveltejs/adapter-auto"\nexport default { plugins: [sveltekit({ adapter: adapter() })] }\n`,
      "vendor/kit/package.json": stub("@sveltejs/kit"),
      "vendor/adapter/package.json": stub("@sveltejs/adapter-cloudflare"),
      "vendor/wrangler/package.json": stub("wrangler"),
    },
    dependencies: {
      "@sveltejs/kit": "file:./vendor/kit",
      "@sveltejs/adapter-cloudflare": "file:./vendor/adapter",
      wrangler: "file:./vendor/wrangler",
    },
    main: ".svelte-kit/cloudflare/_worker.js",
    assets: ".svelte-kit/cloudflare",
    missing: ".svelte-kit/cloudflare/_worker.js",
  },
  {
    kind: "astro-server",
    files: {
      "astro.config.mjs": `export default { output: "server" }\n`,
      "vendor/adapter/package.json": stub("@astrojs/cloudflare"),
      "vendor/wrangler/package.json": stub("wrangler"),
    },
    dependencies: { "@astrojs/cloudflare": "file:./vendor/adapter", wrangler: "file:./vendor/wrangler" },
    main: "dist/server/entry.mjs",
    assets: "dist/client",
    missing: "dist/server/entry.mjs",
  },
  {
    kind: "react-router",
    files: {
      "react-router.config.ts": "export default { ssr: true }\n",
      "vendor/react-router/package.json": stub("react-router"),
      "vendor/isbot/package.json": stub("isbot"),
    },
    dependencies: { "react-router": "file:./vendor/react-router", isbot: "file:./vendor/isbot" },
    // The worker entry is written by adapt, so only the build's assets can be missing.
    main: ".omai/worker.mjs",
    assets: "build/client",
    missing: "build/client",
  },
]

describe("PublishPipeline server kinds", () => {
  for (const item of cases) {
    test(
      `${item.kind} checks the build against the generated wrangler config`,
      async () => {
        const projectID = `prj_${item.kind}`
        const built = {
          // Adapter 7's cache line, which the pipeline patches after a SvelteKit build.
          [item.main]: item.kind === "sveltekit" ? "var s = caches.default;\nexport default {}\n" : "export default {}\n",
          [`${item.assets}/index.html`]: "<h1>built</h1>",
          // A `.env` from `public/` lands in the assets as the frameworks copy it.
          [`${item.assets}/.env`]: "SECRET=1",
          "build/server/index.js": "export {}\n",
        }
        const directory = await project({
          ...item.files,
          "package.json": JSON.stringify({
            name: "fixture",
            private: true,
            scripts: { dev: "vite dev", build: "node build.js" },
            devDependencies: item.dependencies,
          }),
          "build.js": builder(built),
        })
        const stage = path.join(PublishPipeline.projectDir(paths.data, projectID), "stage")
        const before = (await calls()).length

        expect(await run({ projectID, directory })).toEqual({ kind: item.kind })
        const call = (await calls())[before]
        expect(call?.config.main).toBe(path.join(stage, item.main))
        expect(call?.config.assets.directory).toBe(path.join(stage, item.assets))
        expect(call?.assets).toContain("index.html")
        expect(call?.ignore?.split("\n")).toContain(".env*")
        expect(await readFile(path.join(stage, item.main), "utf8")).not.toContain("caches.default")

        // The same project with a build that doesn't write everything the config names.
        await writeFile(
          path.join(directory, "build.js"),
          builder(Object.fromEntries(Object.entries(built).filter((entry) => !entry[0].startsWith(item.missing)))),
        )
        const message = await failure(run({ projectID, directory }))
        expect(message).toBe(`The build finished but didn't write ${item.missing}.`)
        expect(message).not.toContain("undefined")
        expect((await calls()).length).toBe(before + 1)
      },
      60_000,
    )
  }

  test("sveltekit's worker entry inside the assets directory is never uploaded as an asset", async () => {
    const call = (await calls()).find((item) => item.config.main?.endsWith(".svelte-kit/cloudflare/_worker.js"))
    expect(call?.ignore?.split("\n")).toEqual(expect.arrayContaining([".env*", "/_worker.js", "/_routes.json"]))
    // Other kinds keep their entry outside the assets, so nothing else is ignored.
    const next = (await calls()).find((item) => item.config.main?.endsWith(".open-next/worker.js"))
    expect(next?.ignore).toBe(".env*\n")
  })
})

describe("PublishPipeline upload", () => {
  test("spa output gets an .assetsignore for secrets, appended to the project's own", async () => {
    const directory = await project({
      "package.json": JSON.stringify({ name: "fixture", private: true, scripts: { dev: "vite", build: "node build.js" } }),
      "vite.config.js": "export default {}\n",
      "public/.env": "SECRET=1",
      "public/.assetsignore": "drafts",
      "build.js": builder({}) + `fs.cpSync("public", "dist", { recursive: true }); fs.writeFileSync("dist/index.html", "<h1>spa</h1>")\n`,
    })
    const before = (await calls()).length
    expect(await run({ projectID: "prj_spa", directory })).toEqual({ kind: "spa" })
    const call = (await calls())[before]
    expect(call?.assets).toContain(".env")
    expect(call?.ignore).toBe("drafts\n.env*\n")
    // Only the stage is written.
    expect(await readFile(path.join(directory, "public/.assetsignore"), "utf8")).toBe("drafts")
  }, 60_000)

  test("a cancel arriving after a successful upload leaves the deploy live", async () => {
    const directory = await project({ "index.html": "<h1>hi</h1>" })
    const controller = new AbortController()
    const result = await run({
      projectID: "prj_late_cancel",
      directory,
      wrangler: paths.slow,
      signal: controller.signal,
      onLog: (chunk) => {
        if (chunk.includes("Uploaded the new version")) controller.abort()
      },
    })
    expect(result).toEqual({ kind: "static" })
    expect(controller.signal.aborted).toBe(true)
  }, 30_000)

  test("an unsupported project fails as unsupported before installing", async () => {
    const directory = await project({
      "package.json": JSON.stringify({
        name: "fixture",
        private: true,
        scripts: { dev: "astro dev", build: "node build.js" },
        dependencies: { astro: "^5.7.0" },
      }),
      "astro.config.mjs": `export default { output: "server" }\n`,
    })
    const stages: string[] = []
    process.env.OMAI_PUBLISH_WRANGLER = paths.wrangler
    const error = await PublishPipeline.run({
      projectID: "prj_astro5",
      directory,
      dataDir: paths.data,
      name: "site",
      upload: { config },
      signal: new AbortController().signal,
      onStage: (stage) => stages.push(stage),
      onLog: () => {},
    }).catch((cause: unknown) => cause)
    expect(error).toBeInstanceOf(PublishPipeline.PublishFailure)
    expect((error as PublishPipeline.PublishFailure).kind).toBe("unsupported")
    expect(stages).toEqual(["prepare"])
  })

  test("wrangler runs in the publish home, never the stage, and a failed upload says what is live", async () => {
    const directory = await project({ "index.html": "<h1>hi</h1>", ".env": "SECRET=1" })
    const first = await failure(run({ projectID: "prj_upload_fail", directory, wrangler: paths.failing, first: true }))
    expect(first).toBe("The upload to Cloudflare failed. Nothing was published.")
    const home = await realpath(PublishPipeline.projectDir(paths.data, "prj_upload_fail"))
    expect(await realpath(await readFile(paths.cwd, "utf8"))).toBe(home)
    expect((await readdir(home)).toSorted()).toEqual(["stage", "wrangler.json"])

    const again = await failure(run({ projectID: "prj_upload_fail", directory, wrangler: paths.failing }))
    expect(again).toBe("The upload to Cloudflare failed. The previous version is still live.")
  }, 30_000)

  test("a cancel before the upload still stops the publish", async () => {
    const directory = await project({ "index.html": "<h1>hi</h1>" })
    const controller = new AbortController()
    controller.abort()
    const before = (await calls()).length
    expect(await failure(run({ projectID: "prj_early_cancel", directory, signal: controller.signal }))).toBe("The publish was cancelled.")
    expect((await calls()).length).toBe(before)
  })
})
