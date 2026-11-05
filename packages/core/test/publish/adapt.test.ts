import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { PublishAdapt } from "../../src/publish/adapt"
import { PublishStage } from "../../src/publish/stage"

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function temp() {
  const dir = await mkdtemp(path.join(tmpdir(), "omai-adapt-"))
  dirs.push(dir)
  return dir
}

async function write(root: string, files: Record<string, string>) {
  await Promise.all(
    Object.entries(files).map(async ([file, content]) => {
      await mkdir(path.dirname(path.join(root, file)), { recursive: true })
      await writeFile(path.join(root, file), content)
    }),
  )
}

async function exists(file: string) {
  return stat(file).then(
    () => true,
    () => false,
  )
}

async function snapshot(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true })
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const full = path.join(root, entry.name)
      if (entry.isDirectory()) return snapshot(full)
      return [`${full}:${(await stat(full)).mtimeMs}:${await readFile(full, "utf8")}`]
    }),
  )
  return nested.flat().sort()
}

// A project copied into a fresh stage, the way the pipeline does it.
async function staged(files: Record<string, string>) {
  const dir = await temp()
  const project = path.join(dir, "project")
  const stage = path.join(dir, "stage")
  await write(project, files)
  await PublishStage.sync(project, stage)
  return { project, stage }
}

const json = (value: unknown) => JSON.stringify(value, null, 2)
const readJson = async (file: string) => JSON.parse(await readFile(file, "utf8"))

describe("publish build env", () => {
  test("build env hides server secrets", () => {
    const env = PublishAdapt.buildEnv({
      PATH: "/usr/bin",
      HOME: "/home/me",
      OMAI_CLOUDFLARE_API_TOKEN: "token",
      OMAI_CLOUDFLARE_ACCOUNT_ID: "account",
      CLOUDFLARE_API_TOKEN: "token",
      ANTHROPIC_API_KEY: "sk-ant",
      OPENAI_API_KEY: "sk-openai",
      DATABASE_URL: "postgres://secret",
      npm_config_registry: "https://registry.example",
      YARN_CACHE_FOLDER: "/cache",
      PNPM_HOME: "/pnpm",
      COREPACK_HOME: "/corepack",
      NODE_ENV: "development",
    })
    expect(env.PATH).toBe("/usr/bin")
    expect(env.HOME).toBe("/home/me")
    expect(env.OMAI_CLOUDFLARE_API_TOKEN).toBeUndefined()
    expect(env.OMAI_CLOUDFLARE_ACCOUNT_ID).toBeUndefined()
    expect(env.CLOUDFLARE_API_TOKEN).toBeUndefined()
    expect(env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(env.OPENAI_API_KEY).toBeUndefined()
    expect(env.DATABASE_URL).toBeUndefined()
    expect(env.npm_config_registry).toBe("https://registry.example")
    expect(env.YARN_CACHE_FOLDER).toBe("/cache")
    expect(env.PNPM_HOME).toBe("/pnpm")
    expect(env.COREPACK_HOME).toBe("/corepack")
    expect(env.NODE_ENV).toBe("production")
    expect(env.CI).toBe("1")
  })

  test("extras are added on top of the allowlist", () => {
    const env = PublishAdapt.buildEnv({ PATH: "/bin", SECRET: "x" }, { NITRO_PRESET: "cloudflare_module" })
    expect(env).toEqual({ PATH: "/bin", NODE_ENV: "production", CI: "1", NITRO_PRESET: "cloudflare_module" })
  })
})

describe("publish adapt", () => {
  test("adapt never touches the project", async () => {
    const fixtures: [Parameters<typeof PublishAdapt.adapt>[1], Record<string, string>][] = [
      [
        "astro-server",
        {
          "package.json": json({ dependencies: { astro: "^7.0.0", "@astrojs/node": "^9.0.0" } }),
          "astro.config.mjs": `import { defineConfig } from "astro/config"\nimport node from "@astrojs/node"\n\nexport default defineConfig({ output: "server", adapter: node({ mode: "standalone" }) })\n`,
          "wrangler.toml": `name = "mine"\n`,
        },
      ],
      [
        "sveltekit",
        {
          "package.json": json({ devDependencies: { "@sveltejs/adapter-auto": "^6.0.0" } }),
          "svelte.config.js": `import adapter from "@sveltejs/adapter-auto"\nexport default { kit: { adapter: adapter() } }\n`,
        },
      ],
      ["next", { "package.json": json({ dependencies: { next: "16.4.5" } }), "next.config.mjs": "export default {}\n" }],
      ["nuxt", { "package.json": json({ dependencies: { nuxt: "^4.0.0" } }) }],
      ["react-router", { "package.json": json({ dependencies: { "react-router": "^8.0.0" } }) }],
    ]
    for (const [kind, files] of fixtures) {
      const { project, stage } = await staged(files)
      const before = await snapshot(project)
      await PublishAdapt.adapt(stage, kind)
      expect(await snapshot(project)).toEqual(before)
    }
  })

  test("sveltekit adapter is swapped in the stage", async () => {
    const { stage } = await staged({
      "package.json": json({ devDependencies: { "@sveltejs/kit": "^2.0.0", "@sveltejs/adapter-node": "^5.0.0" } }),
      "svelte.config.js": `import adapter from '@sveltejs/adapter-node'\n\nexport default { kit: { adapter: adapter() } }\n`,
      "wrangler.jsonc": `{ "pages_build_output_dir": "elsewhere" }`,
    })
    const result = await PublishAdapt.adapt(stage, "sveltekit")
    expect(await readFile(path.join(stage, "svelte.config.js"), "utf8")).toBe(
      `import adapter from '@sveltejs/adapter-cloudflare'\n\nexport default { kit: { adapter: adapter() } }\n`,
    )
    const pkg = await readJson(path.join(stage, "package.json"))
    expect(pkg.devDependencies["@sveltejs/adapter-cloudflare"]).toBe(PublishAdapt.SVELTE_ADAPTERS[2])
    expect(result.installs).toContain(`@sveltejs/adapter-cloudflare@${PublishAdapt.SVELTE_ADAPTERS[2]}`)
    // The adapter would otherwise follow the project's wrangler file and build somewhere our config doesn't point.
    expect(await exists(path.join(stage, "wrangler.jsonc"))).toBe(false)
  })

  test("sveltekit 3 has its adapter swapped in vite.config", async () => {
    const vite = `import adapter from "@sveltejs/adapter-auto"\nimport { sveltekit } from "@sveltejs/kit/vite"\nimport { defineConfig } from "vite"\nexport default defineConfig({ plugins: [sveltekit({ adapter: adapter() })] })\n`
    const { stage } = await staged({
      "package.json": json({ devDependencies: { "@sveltejs/kit": "^3.1.1", "@sveltejs/adapter-auto": "^8.0.0" } }),
      "vite.config.js": vite,
    })
    const result = await PublishAdapt.adapt(stage, "sveltekit")
    expect(await readFile(path.join(stage, "vite.config.js"), "utf8")).toBe(
      vite.replace("@sveltejs/adapter-auto", "@sveltejs/adapter-cloudflare"),
    )
    expect(await exists(path.join(stage, "svelte.config.js"))).toBe(false)
    const pkg = await readJson(path.join(stage, "package.json"))
    expect(pkg.devDependencies["@sveltejs/adapter-cloudflare"]).toBe(PublishAdapt.SVELTE_ADAPTERS[3])
    expect(result.installs).toEqual([
      `@sveltejs/adapter-cloudflare@${PublishAdapt.SVELTE_ADAPTERS[3]}`,
      `wrangler@${PublishAdapt.VERSIONS.wrangler}`,
    ])
  })

  test("sveltekit 2 with a plain vite.config keeps it as is", async () => {
    const vite = `import { sveltekit } from "@sveltejs/kit/vite"\nexport default { plugins: [sveltekit()] }\n`
    const { stage } = await staged({
      "package.json": json({ devDependencies: { "@sveltejs/kit": "^2.70.4", "@sveltejs/adapter-auto": "^7.0.1" } }),
      "svelte.config.js": `import adapter from "@sveltejs/adapter-auto"\nexport default { kit: { adapter: adapter() } }\n`,
      "vite.config.js": vite,
    })
    await PublishAdapt.adapt(stage, "sveltekit")
    expect(await readFile(path.join(stage, "vite.config.js"), "utf8")).toBe(vite)
    expect(await readFile(path.join(stage, "svelte.config.js"), "utf8")).toContain(`"@sveltejs/adapter-cloudflare"`)
  })

  test("the sveltekit adapter follows the kit major", () => {
    expect(PublishAdapt.SVELTE_ADAPTERS[2]).toMatch(/^7\.\d+\.\d+$/)
    expect(PublishAdapt.SVELTE_ADAPTERS[3]).toMatch(/^8\.\d+\.\d+$/)
    expect(PublishAdapt.svelteAdapter("^2.70.4")).toBe(PublishAdapt.SVELTE_ADAPTERS[2])
    expect(PublishAdapt.svelteAdapter("2.5.0")).toBe(PublishAdapt.SVELTE_ADAPTERS[2])
    expect(PublishAdapt.svelteAdapter(">=2.0.0 <3")).toBe(PublishAdapt.SVELTE_ADAPTERS[2])
    expect(PublishAdapt.svelteAdapter("workspace:^2.1.0")).toBe(PublishAdapt.SVELTE_ADAPTERS[2])
    expect(PublishAdapt.svelteAdapter("^3.1.1")).toBe(PublishAdapt.SVELTE_ADAPTERS[3])
    expect(PublishAdapt.svelteAdapter("3.0.0-next.4")).toBe(PublishAdapt.SVELTE_ADAPTERS[3])
    // A range without a major falls back to the installed copy, then to the current major.
    expect(PublishAdapt.svelteAdapter("latest", "2.70.4")).toBe(PublishAdapt.SVELTE_ADAPTERS[2])
    expect(PublishAdapt.svelteAdapter("file:../kit", "3.1.1")).toBe(PublishAdapt.SVELTE_ADAPTERS[3])
    expect(PublishAdapt.svelteAdapter("*")).toBe(PublishAdapt.SVELTE_ADAPTERS[3])
    expect(PublishAdapt.svelteAdapter(undefined)).toBe(PublishAdapt.SVELTE_ADAPTERS[3])
    // The declared range wins over a stale install from the previous publish.
    expect(PublishAdapt.svelteAdapter("^3.0.0", "2.70.4")).toBe(PublishAdapt.SVELTE_ADAPTERS[3])
  })

  test("the installed kit picks the adapter when the range names no major", async () => {
    const { stage } = await staged({
      "package.json": json({ devDependencies: { "@sveltejs/kit": "latest" } }),
      "svelte.config.js": `import adapter from "@sveltejs/adapter-auto"\nexport default { kit: { adapter: adapter() } }\n`,
    })
    await write(stage, { "node_modules/@sveltejs/kit/package.json": json({ name: "@sveltejs/kit", version: "2.70.4" }) })
    await PublishAdapt.adapt(stage, "sveltekit")
    expect((await readJson(path.join(stage, "package.json"))).devDependencies["@sveltejs/adapter-cloudflare"]).toBe(
      PublishAdapt.SVELTE_ADAPTERS[2],
    )
  })

  test("adapters that peer on wrangler get it as a dev dependency", async () => {
    for (const kind of ["astro-server", "sveltekit", "next"] as const) {
      const { stage } = await staged({
        "package.json": json({ dependencies: {} }),
        "astro.config.mjs": `export default { output: "server" }\n`,
      })
      const result = await PublishAdapt.adapt(stage, kind)
      expect((await readJson(path.join(stage, "package.json"))).devDependencies.wrangler).toBe(PublishAdapt.VERSIONS.wrangler)
      expect(result.installs).toContain(`wrangler@${PublishAdapt.VERSIONS.wrangler}`)
    }
    // A project's own wrangler is kept.
    const { stage } = await staged({ "package.json": json({ devDependencies: { wrangler: "^4.150.0" } }) })
    const result = await PublishAdapt.adapt(stage, "next")
    expect((await readJson(path.join(stage, "package.json"))).devDependencies.wrangler).toBe("^4.150.0")
    expect(result.installs.some((spec) => spec.startsWith("wrangler@"))).toBe(false)
  })

  test("the deprecated workers adapter is swapped, the current one left alone", async () => {
    const { stage } = await staged({
      "package.json": json({ devDependencies: { "@sveltejs/adapter-cloudflare": "^7.0.0" } }),
      "svelte.config.js": `import adapter from "@sveltejs/adapter-cloudflare-workers"\nexport default { kit: { adapter: adapter() } }\n`,
    })
    const result = await PublishAdapt.adapt(stage, "sveltekit")
    expect(await readFile(path.join(stage, "svelte.config.js"), "utf8")).toContain(`"@sveltejs/adapter-cloudflare"`)
    // An adapter the project already depends on keeps its version.
    expect((await readJson(path.join(stage, "package.json"))).devDependencies["@sveltejs/adapter-cloudflare"]).toBe(
      "^7.0.0",
    )
    expect(result.installs.some((spec) => spec.startsWith("@sveltejs/adapter-cloudflare@"))).toBe(false)
  })

  test("astro uses the cloudflare adapter in place of any other", async () => {
    const { stage } = await staged({
      "package.json": json({ dependencies: { astro: "^7.0.0", "@astrojs/node": "^9.0.0" } }),
      "astro.config.mjs": `import { defineConfig } from "astro/config"\nimport node from "@astrojs/node"\n\nexport default defineConfig({\n  output: "server",\n  adapter: node({ mode: "standalone", nested: fn() }),\n})\n`,
    })
    const result = await PublishAdapt.adapt(stage, "astro-server")
    const config = await readFile(path.join(stage, "astro.config.mjs"), "utf8")
    expect(config).toContain(`import cloudflare from "@astrojs/cloudflare"`)
    expect(config).toContain("adapter: cloudflare(),")
    expect(config).not.toContain("@astrojs/node")
    expect(config).not.toContain("standalone")
    expect(config).toContain(`output: "server"`)
    const pkg = await readJson(path.join(stage, "package.json"))
    expect(pkg.devDependencies["@astrojs/cloudflare"]).toBe(PublishAdapt.ASTRO_ADAPTERS[7])
    expect(result.installs).toContain(`@astrojs/cloudflare@${PublishAdapt.ASTRO_ADAPTERS[7]}`)
  })

  test("astro without an adapter gets one", async () => {
    const { stage } = await staged({
      "package.json": json({ dependencies: { astro: "^7.0.0" } }),
      "astro.config.ts": `import { defineConfig } from "astro/config"\n\nexport default defineConfig({ output: "server" })\n`,
    })
    await PublishAdapt.adapt(stage, "astro-server")
    const config = await readFile(path.join(stage, "astro.config.ts"), "utf8")
    expect(config).toContain(`import cloudflare from "@astrojs/cloudflare"`)
    expect(config).toContain(`defineConfig({\n  adapter: cloudflare(),\n output: "server" })`)
  })

  test("next gets opennext, its config and build command", async () => {
    const { stage } = await staged({ "package.json": json({ dependencies: { next: "16.4.5" } }) })
    const result = await PublishAdapt.adapt(stage, "next")
    expect(await readFile(path.join(stage, "open-next.config.ts"), "utf8")).toContain("defineCloudflareConfig()")
    expect((await readJson(path.join(stage, "package.json"))).devDependencies["@opennextjs/cloudflare"]).toBe(
      PublishAdapt.VERSIONS["@opennextjs/cloudflare"],
    )
    expect(result.build).toBe("npx opennextjs-cloudflare build")
    expect(result.env.SKIP_WRANGLER_CONFIG_CHECK).toBe("yes")
  })

  test("next keeps an existing open-next config", async () => {
    const { stage } = await staged({
      "package.json": json({ dependencies: { next: "16.4.5" } }),
      "open-next.config.ts": "// mine\n",
    })
    await PublishAdapt.adapt(stage, "next")
    expect(await readFile(path.join(stage, "open-next.config.ts"), "utf8")).toBe("// mine\n")
  })

  test("nuxt and solidstart build with the cloudflare nitro preset", async () => {
    for (const kind of ["nuxt", "solidstart"] as const) {
      const { stage } = await staged({ "package.json": json({}) })
      const result = await PublishAdapt.adapt(stage, kind)
      expect(result.env).toEqual({ NITRO_PRESET: "cloudflare_module" })
      expect(result.installs).toEqual([])
    }
  })

  test("react router gets a worker entry and a Web-streams entry.server", async () => {
    const { project, stage } = await staged({
      "package.json": json({ dependencies: { "react-router": "^8.0.0" } }),
      "app/root.jsx": "export default () => null\n",
    })
    const result = await PublishAdapt.adapt(stage, "react-router")
    const worker = await readFile(path.join(stage, ".omai/worker.mjs"), "utf8")
    expect(worker).toContain(`from "react-router"`)
    expect(worker).toContain(`"../build/server/index.js"`)
    const entry = await readFile(path.join(stage, "app/entry.server.js"), "utf8")
    expect(entry).toContain(`import { renderToReadableStream } from "react-dom/server"`)
    expect(entry).toContain(`import { ServerRouter } from "react-router"`)
    expect(entry).toContain("isbot(userAgent)")
    expect(entry).toContain("await body.allReady")
    expect(entry).not.toContain("renderToPipeableStream")
    expect(entry).not.toContain("node:stream")
    // The entry imports isbot, which the framework only adds for its own default entry.
    expect(result.installs).toEqual([`isbot@${PublishAdapt.VERSIONS.isbot}`])
    expect(await exists(path.join(project, "app/entry.server.js"))).toBe(false)
  })

  test("the generated entry.server goes into the configured app directory", async () => {
    const { stage } = await staged({
      "package.json": json({ dependencies: { "react-router": "^8.0.0", isbot: "^5.0.0" } }),
      "react-router.config.ts": `export default { appDirectory: "./src/app", ssr: true }\n`,
    })
    const result = await PublishAdapt.adapt(stage, "react-router")
    expect(await exists(path.join(stage, "src/app/entry.server.js"))).toBe(true)
    expect(await exists(path.join(stage, "app/entry.server.js"))).toBe(false)
    expect(result.installs).toEqual([])
  })

  test("a project's Web-streams entry.server is kept", async () => {
    const own = `import { renderToReadableStream } from "react-dom/server"\nexport default async function handleRequest() {}\n`
    const { stage } = await staged({
      "package.json": json({ dependencies: { "react-router": "^8.0.0" } }),
      "app/entry.server.tsx": own,
    })
    const result = await PublishAdapt.adapt(stage, "react-router")
    expect(await readFile(path.join(stage, "app/entry.server.tsx"), "utf8")).toBe(own)
    expect(await exists(path.join(stage, "app/entry.server.js"))).toBe(false)
    expect(result.installs).toEqual([])
  })

  test("a project's Node-streams entry.server fails with a plain reason", async () => {
    for (const source of [
      `import { renderToPipeableStream } from "react-dom/server"\n`,
      `import { PassThrough } from "node:stream"\n`,
    ]) {
      const { stage } = await staged({
        "package.json": json({ dependencies: { "react-router": "^8.0.0" } }),
        "app/entry.server.jsx": source,
      })
      const error = await PublishAdapt.adapt(stage, "react-router").catch((cause: unknown) => cause)
      expect(error).toBeInstanceOf(PublishAdapt.Unsupported)
      expect((error as Error).message).toContain("Publishing needs an entry.server that renders with Web streams")
      expect((error as Error).message).toContain("app/entry.server.jsx")
    }
  })

  test("remix gets a worker entry on the cloudflare runtime", async () => {
    const { stage } = await staged({
      "package.json": json({ dependencies: { "@remix-run/node": "^2.15.0", "@remix-run/react": "^2.15.0" } }),
    })
    const result = await PublishAdapt.adapt(stage, "react-router")
    expect(await readFile(path.join(stage, ".omai/worker.mjs"), "utf8")).toContain(`from "@remix-run/cloudflare"`)
    expect(await readFile(path.join(stage, "app/entry.server.js"), "utf8")).toContain(
      `import { RemixServer } from "@remix-run/react"`,
    )
    expect(result.installs).toEqual(["@remix-run/cloudflare@^2.15.0", `isbot@${PublishAdapt.VERSIONS.isbot}`])
  })

  test("the astro adapter follows the astro major", () => {
    expect(PublishAdapt.ASTRO_ADAPTERS[6]).toMatch(/^13\.\d+\.\d+$/)
    expect(PublishAdapt.ASTRO_ADAPTERS[7]).toMatch(/^14\.\d+\.\d+$/)
    expect(PublishAdapt.astroAdapter("^6.3.0")).toBe(PublishAdapt.ASTRO_ADAPTERS[6])
    expect(PublishAdapt.astroAdapter("^7.4.6")).toBe(PublishAdapt.ASTRO_ADAPTERS[7])
    expect(PublishAdapt.astroAdapter("latest", "6.4.0")).toBe(PublishAdapt.ASTRO_ADAPTERS[6])
    expect(PublishAdapt.astroAdapter("*")).toBe(PublishAdapt.ASTRO_ADAPTERS[7])
    expect(PublishAdapt.astroAdapter("^5.7.0")).toBeUndefined()
    expect(PublishAdapt.astroAdapter("^4.0.0")).toBeUndefined()
  })

  test("astro 6 gets the 13.x adapter and wrangler", async () => {
    const { stage } = await staged({
      "package.json": json({ dependencies: { astro: "^6.3.0" } }),
      "astro.config.mjs": `export default { output: "server" }\n`,
    })
    const result = await PublishAdapt.adapt(stage, "astro-server")
    expect(result.installs).toEqual([
      `@astrojs/cloudflare@${PublishAdapt.ASTRO_ADAPTERS[6]}`,
      `wrangler@${PublishAdapt.VERSIONS.wrangler}`,
    ])
  })

  test("astro before 6 is unsupported", async () => {
    const { stage } = await staged({
      "package.json": json({ dependencies: { astro: "^5.7.0" } }),
      "astro.config.mjs": `export default { output: "server" }\n`,
    })
    const error = await PublishAdapt.adapt(stage, "astro-server").catch((cause: unknown) => cause)
    expect(error).toBeInstanceOf(PublishAdapt.Unsupported)
    expect((error as Error).message).toBe(
      "O M A I + publishes Astro 6 and newer server sites. Update astro to publish this project.",
    )
  })

  test("finish swaps the kit 2 worker's default cache for an empty one", async () => {
    const dir = await temp()
    const main = path.join(dir, "_worker.js")
    const kit2 = `var s = caches.default;\nvar c = t.bind(0, s);\nplatform: { caches }\n`
    await writeFile(main, kit2)
    await PublishAdapt.finish("sveltekit", main)
    const patched = await readFile(main, "utf8")
    expect(patched).not.toContain("caches.default")
    expect(patched).toContain("var s = { match: async () => undefined, put: async () => {} };")
    expect(patched).toContain("var c = t.bind(0, s);")
    // Adapter 8 output and other kinds are left alone.
    const kit3 = `export default { fetch() {} }\n`
    await writeFile(main, kit3)
    await PublishAdapt.finish("sveltekit", main)
    expect(await readFile(main, "utf8")).toBe(kit3)
    await writeFile(main, kit2)
    await PublishAdapt.finish("next", main)
    expect(await readFile(main, "utf8")).toBe(kit2)
  })

  test("static kinds are left as they are", async () => {
    const { stage } = await staged({ "index.html": "<h1>hi</h1>" })
    const before = await snapshot(stage)
    expect(await PublishAdapt.adapt(stage, "static")).toEqual({ installs: [], env: {} })
    expect(await snapshot(stage)).toEqual(before)
  })
})
