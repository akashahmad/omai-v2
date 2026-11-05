import { afterEach, describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { PublishWrangler } from "../../src/publish/wrangler"

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function temp() {
  const dir = await mkdtemp(path.join(tmpdir(), "omai-wrangler-"))
  dirs.push(dir)
  return dir
}

describe("publish wrangler", () => {
  test("wranglerConfig uses SPA fallback for spa and 404 page for pages", () => {
    const spa = PublishWrangler.wranglerConfig("spa", { name: "app", stage: "/stage", output: "dist" })
    expect(spa).toEqual({
      name: "app",
      compatibility_date: "2026-10-01",
      assets: { directory: path.join("/stage", "dist"), not_found_handling: "single-page-application" },
    })
    const pages = PublishWrangler.wranglerConfig("pages", { name: "app", stage: "/stage", output: "public" })
    expect(pages).toMatchObject({ assets: { directory: path.join("/stage", "public"), not_found_handling: "404-page" } })
    const site = PublishWrangler.wranglerConfig("static", { name: "app", stage: "/stage" })
    expect(site).toMatchObject({ assets: { directory: path.join("/stage", ".omai-static"), not_found_handling: "404-page" } })
  })

  test("server kinds run a worker with the assets binding", () => {
    const next = PublishWrangler.wranglerConfig("next", { name: "app", stage: "/stage" })
    expect(next).toEqual({
      name: "app",
      compatibility_date: "2026-10-01",
      main: path.join("/stage", ".open-next/worker.js"),
      assets: { directory: path.join("/stage", ".open-next/assets"), binding: "ASSETS" },
      compatibility_flags: ["nodejs_compat", "global_fetch_strictly_public"],
    })
    const router = PublishWrangler.wranglerConfig("react-router", { name: "app", stage: "/stage" })
    expect(router).toMatchObject({
      main: path.join("/stage", ".omai/worker.mjs"),
      assets: { directory: path.join("/stage", "build/client"), binding: "ASSETS" },
      compatibility_flags: ["nodejs_compat"],
    })
    for (const kind of ["nuxt", "solidstart", "sveltekit", "astro-server"] as const) {
      const config = PublishWrangler.wranglerConfig(kind, { name: "app", stage: "/stage" })
      expect(config).toMatchObject({ compatibility_flags: ["nodejs_compat"], assets: { binding: "ASSETS" } })
      expect("main" in config).toBe(true)
    }
  })

  test("wranglerConfig never reads the project's wrangler.toml", async () => {
    const stage = await temp()
    await writeFile(
      path.join(stage, "wrangler.toml"),
      `name = "theirs"\nmain = "src/index.ts"\n\n[[kv_namespaces]]\nbinding = "CACHE"\nid = "abc"\n`,
    )
    for (const kind of ["static", "spa", "pages", "next", "nuxt", "solidstart", "sveltekit", "astro-server", "react-router"] as const) {
      const config = PublishWrangler.wranglerConfig(kind, { name: "app", stage, output: "dist" })
      const text = JSON.stringify(config)
      expect(text).not.toContain("kv_namespaces")
      expect(text).not.toContain("theirs")
      expect(text).not.toContain("src/index.ts")
    }
  })

  test("deployArgs uploads into the dispatch namespace with the generated config", () => {
    expect(PublishWrangler.deployArgs({ name: "app", namespace: "omai-apps", config: "/stage/.omai/wrangler.json" })).toEqual([
      "deploy",
      "--dispatch-namespace",
      "omai-apps",
      "--name",
      "app",
      "--config",
      "/stage/.omai/wrangler.json",
    ])
  })

  test("the wrangler version is pinned", () => {
    expect(PublishWrangler.WRANGLER_VERSION).toMatch(/^4\.\d+\.\d+$/)
  })

  test("ensureWrangler uses the override bin", async () => {
    const tools = await temp()
    expect(await PublishWrangler.ensureWrangler(tools, { OMAI_PUBLISH_WRANGLER: "/opt/fake-wrangler" })).toBe(
      "/opt/fake-wrangler",
    )
  })

  test("ensureWrangler reuses an install of the pinned version", async () => {
    const tools = await temp()
    await mkdir(path.join(tools, "node_modules/wrangler"), { recursive: true })
    await writeFile(
      path.join(tools, "node_modules/wrangler/package.json"),
      JSON.stringify({ name: "wrangler", version: PublishWrangler.WRANGLER_VERSION }),
    )
    // PATH is empty so an attempted npm install would fail rather than reach the network.
    expect(await PublishWrangler.ensureWrangler(tools, { PATH: "" })).toBe(path.join(tools, "node_modules/.bin/wrangler"))
  })

  test("ensureWrangler installs when the installed version differs", async () => {
    const tools = await temp()
    await mkdir(path.join(tools, "node_modules/wrangler"), { recursive: true })
    await writeFile(
      path.join(tools, "node_modules/wrangler/package.json"),
      JSON.stringify({ name: "wrangler", version: "3.0.0" }),
    )
    // With no PATH, npm can't be found, so the install attempt fails instead of reaching the network.
    await expect(PublishWrangler.ensureWrangler(tools, { PATH: "" })).rejects.toThrow()
  })

  test("concurrent installs into one directory share one npm run, and a failed one is not kept", async () => {
    const tools = await temp()
    const bin = await temp()
    const runs = path.join(bin, "runs")
    // A stand-in npm: counts its runs, fails the first one, and installs the pinned version on every later one.
    await writeFile(
      path.join(bin, "npm"),
      `#!/bin/sh
echo run >> ${JSON.stringify(runs)}
sleep 0.2
if [ "$(wc -l < ${JSON.stringify(runs)})" -eq 1 ]; then exit 1; fi
mkdir -p node_modules/wrangler
echo '{"name":"wrangler","version":"${PublishWrangler.WRANGLER_VERSION}"}' > node_modules/wrangler/package.json
`,
    )
    await chmod(path.join(bin, "npm"), 0o755)
    const env = { PATH: `${bin}:/bin:/usr/bin` }
    const count = async () => (await readFile(runs, "utf8")).trim().split("\n").length

    const failed = await Promise.allSettled([
      PublishWrangler.ensureWrangler(tools, env),
      PublishWrangler.ensureWrangler(tools, env),
    ])
    expect(failed.map((result) => result.status)).toEqual(["rejected", "rejected"])
    expect(await count()).toBe(1)

    const installed = await Promise.all([
      PublishWrangler.ensureWrangler(tools, env),
      PublishWrangler.ensureWrangler(path.join(tools, "."), env),
    ])
    expect(installed).toEqual([path.join(tools, "node_modules/.bin/wrangler"), path.join(tools, "node_modules/.bin/wrangler")])
    expect(await count()).toBe(2)
  })
})
