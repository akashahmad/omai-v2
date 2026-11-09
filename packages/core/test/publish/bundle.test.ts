import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import yauzl from "yauzl"
import { PublishBundle } from "../../src/publish/bundle"
import { PublishWrangler } from "../../src/publish/wrangler"
import { tmpdir } from "../fixture/tmpdir"

let root: Awaited<ReturnType<typeof tmpdir>>
const paths = { wrangler: "", calls: "" }

// The fake wrangler writes a bundled worker into --outdir the way `wrangler deploy --dry-run` does, and records the
// environment it ran with.
beforeAll(async () => {
  root = await tmpdir("omai-publish-bundle-")
  paths.calls = path.join(root.path, "calls.json")
  paths.wrangler = path.join(root.path, "fake-wrangler.mjs")
  await writeFile(
    paths.wrangler,
    `#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
const args = process.argv.slice(2)
const outdir = args[args.indexOf("--outdir") + 1]
mkdirSync(path.join(outdir, "chunks"), { recursive: true })
writeFileSync(path.join(outdir, "index.js"), "export default {}")
writeFileSync(path.join(outdir, "index.js.map"), "{}")
writeFileSync(path.join(outdir, "chunks", "a.js"), "")
writeFileSync(path.join(outdir, "README.md"), "dry run")
writeFileSync(${JSON.stringify(paths.calls)}, JSON.stringify({ args, env: process.env, cwd: process.cwd() }))
`,
  )
  await chmod(paths.wrangler, 0o755)
})

afterAll(() => root[Symbol.asyncDispose]())

async function entries(zip: string) {
  const names: string[] = []
  await new Promise<void>((resolve, reject) =>
    yauzl.open(zip, { lazyEntries: true }, (error, file) => {
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

async function stage(name: string) {
  const home = path.join(root.path, name)
  const stageDir = path.join(home, "stage")
  await mkdir(path.join(stageDir, ".output", "public", "img"), { recursive: true })
  await mkdir(path.join(stageDir, ".output", "server"), { recursive: true })
  await writeFile(path.join(stageDir, ".output", "public", "index.html"), "hi")
  await writeFile(path.join(stageDir, ".output", "public", "img", "a.png"), "png")
  await writeFile(path.join(stageDir, ".output", "public", ".env"), "SECRET=1")
  await writeFile(path.join(stageDir, ".output", "public", ".assetsignore"), ".env*\n")
  await writeFile(path.join(stageDir, ".output", "server", "index.mjs"), "export default {}")
  return { home, stage: stageDir }
}

describe("publish bundle", () => {
  test("pack runs wrangler without Cloudflare variables and zips the bundled worker and the assets", async () => {
    const dirs = await stage("server")
    const generated = PublishWrangler.wranglerConfig("nuxt", { name: "site", stage: dirs.stage })
    const saved = { ...process.env }
    Object.assign(process.env, { OMAI_CLOUDFLARE_API_TOKEN: "cf-secret", CLOUDFLARE_API_TOKEN: "cf-secret-2" })
    const packed = await PublishBundle.pack({
      kind: "nuxt",
      name: "site",
      home: dirs.home,
      generated,
      wrangler: paths.wrangler,
      signal: new AbortController().signal,
      onLog: () => {},
    }).finally(() => {
      delete process.env.OMAI_CLOUDFLARE_API_TOKEN
      delete process.env.CLOUDFLARE_API_TOKEN
      Object.assign(process.env, saved)
    })

    const call = JSON.parse(await readFile(paths.calls, "utf8"))
    expect(call.args.slice(0, 3)).toEqual(["deploy", "--dry-run", "--outdir"])
    expect(Object.keys(call.env).filter((key) => key.includes("CLOUDFLARE"))).toEqual([])
    expect(call.cwd).toBe(await import("node:fs/promises").then((fs) => fs.realpath(dirs.home)))
    expect(packed.entry).toBe("index.js")
    expect(await entries(packed.zip)).toEqual([
      "bundle/assets/.assetsignore",
      "bundle/assets/img/a.png",
      "bundle/assets/index.html",
      "bundle/worker/chunks/a.js",
      "bundle/worker/index.js",
    ])
  })

  test("pack for a static kind zips only the assets", async () => {
    const dirs = await stage("static")
    const generated = PublishWrangler.wranglerConfig("spa", { name: "site", stage: dirs.stage, output: ".output/public" })
    const packed = await PublishBundle.pack({
      kind: "spa",
      name: "site",
      home: dirs.home,
      generated,
      wrangler: "/nonexistent/wrangler",
      signal: new AbortController().signal,
      onLog: () => {},
    })
    expect(packed.entry).toBeUndefined()
    expect(await entries(packed.zip)).toEqual([
      "bundle/assets/.assetsignore",
      "bundle/assets/img/a.png",
      "bundle/assets/index.html",
    ])
  })
})
