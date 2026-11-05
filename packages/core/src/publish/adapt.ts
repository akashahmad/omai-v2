export * as PublishAdapt from "./adapt.js"

import type { Publish } from "@opencode/schema/publish"
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"

/** Adapter versions added to a staged project that doesn't already depend on them. */
export const VERSIONS = {
  "@opennextjs/cloudflare": "1.20.16",
  "@remix-run/cloudflare": "2.17.5",
  // The adapters above (and the SvelteKit one) list wrangler as a peer. It is added as a plain dev dependency, because
  // the install retry with relaxed peer handling (`--legacy-peer-deps`) would skip it. Also the version uploads use.
  wrangler: "4.158.0",
  // Imported by the generated React Router entry.server.
  isbot: "5.2.2",
} as const

/** `@sveltejs/adapter-cloudflare` per `@sveltejs/kit` major: 8.x requires Kit 3, 7.x is the last line for Kit 2. */
export const SVELTE_ADAPTERS = { 2: "7.2.10", 3: "8.0.2" } as const

/**
 * `@astrojs/cloudflare` per `astro` major: 14.x requires Astro 7.4, 13.x Astro 6. Both build through the Cloudflare
 * Vite plugin to `dist/server/entry.mjs` and `dist/client`; 12.x (Astro 5) writes another layout and isn't offered.
 */
export const ASTRO_ADAPTERS = { 6: "13.7.0", 7: "14.4.4" } as const

/** A project the pipeline can't publish, with a plain reason. */
export class Unsupported extends Error {
  override name = "Unsupported"
}

const NAMES: ReadonlySet<string> = new Set(["PATH", "HOME", "USER", "LANG", "LC_ALL", "TMPDIR", "SHELL", "TERM"])
const PREFIXES = ["npm_config_", "NPM_CONFIG_", "YARN_", "PNPM_", "COREPACK_"]

/**
 * Environment for install and build commands, which run the user's code. Only the allowlisted names pass, so server
 * secrets (`OMAI_*`, `CLOUDFLARE_*`, provider keys, database URLs) never reach them. `extra` is added last.
 */
export function buildEnv(
  source: Record<string, string | undefined> = process.env,
  extra: Record<string, string> = {},
): Record<string, string> {
  const allowed = Object.entries(source).filter(
    (entry): entry is [string, string] =>
      entry[1] !== undefined && (NAMES.has(entry[0]) || PREFIXES.some((prefix) => entry[0].startsWith(prefix))),
  )
  return { ...Object.fromEntries(allowed), NODE_ENV: "production", CI: "1", ...extra }
}

export type Result = {
  /** `name@version` specs added to the stage package.json; installing the stage again picks them up. */
  installs: string[]
  /** Extra build environment, passed to `buildEnv`. */
  env: Record<string, string>
  /** Replaces the detected build command. */
  build?: string
}

/** Prepares the staged copy of a project to build for Cloudflare Workers. Only `stage` is written. */
export async function adapt(stage: string, kind: Publish.Kind): Promise<Result> {
  if (kind === "static" || kind === "spa" || kind === "pages") return { installs: [], env: {} }
  // Adapters follow a project's wrangler file (output directory, entry, bindings). Without it they build to the
  // default layout that the generated config points at.
  await Promise.all(
    ["wrangler.toml", "wrangler.json", "wrangler.jsonc"].map((file) => rm(path.join(stage, file), { force: true })),
  )

  if (kind === "nuxt" || kind === "solidstart") return { installs: [], env: { NITRO_PRESET: "cloudflare_module" } }

  if (kind === "astro-server") {
    const adapter = astroAdapter((await packageDependencies(stage)).astro, await installed(stage, "astro"))
    if (!adapter) throw new Unsupported("O M A I + publishes Astro 6 and newer server sites. Update astro to publish this project.")
    const installs = [
      ...(await addDependency(stage, "@astrojs/cloudflare", adapter)),
      ...(await addDependency(stage, "wrangler", VERSIONS.wrangler)),
    ]
    const file = await configFile(stage, "astro.config")
    if (file) await writeFile(file, useAstroCloudflare(await readFile(file, "utf8"), path.basename(file)))
    return { installs, env: {} }
  }

  if (kind === "sveltekit") {
    const adapter = svelteAdapter((await packageDependencies(stage))["@sveltejs/kit"], await installed(stage, "@sveltejs/kit"))
    const installs = [
      ...(await addDependency(stage, "@sveltejs/adapter-cloudflare", adapter)),
      ...(await addDependency(stage, "wrangler", VERSIONS.wrangler)),
    ]
    // Kit 2 configures the adapter in svelte.config, Kit 3 in the sveltekit() plugin options of vite.config.
    const files = [await configFile(stage, "svelte.config"), await configFile(stage, "vite.config")]
    await Promise.all(
      files
        .filter((file) => file !== undefined)
        .map(async (file) => {
          const text = await readFile(file, "utf8")
          // "-workers" is the deprecated adapter, so it is rewritten too.
          if (/@sveltejs\/adapter-cloudflare(?![\w-])/.test(text)) return
          const swapped = text.replace(/@sveltejs\/adapter-[\w-]+/g, "@sveltejs/adapter-cloudflare")
          if (swapped !== text) await writeFile(file, swapped)
        }),
    )
    return { installs, env: {} }
  }

  if (kind === "next") {
    const installs = [
      ...(await addDependency(stage, "@opennextjs/cloudflare", VERSIONS["@opennextjs/cloudflare"])),
      ...(await addDependency(stage, "wrangler", VERSIONS.wrangler)),
    ]
    await writeFile(path.join(stage, "open-next.config.ts"), OPEN_NEXT_CONFIG, { flag: "wx" }).catch((error) => {
      if (error?.code !== "EEXIST") throw error
    })
    // OpenNext refuses to build in CI without a wrangler file; the deploy uses the generated config instead.
    return { installs, env: { SKIP_WRANGLER_CONFIG_CHECK: "yes" }, build: "npx opennextjs-cloudflare build" }
  }

  const dependencies = await packageDependencies(stage)
  const remix = !dependencies["react-router"]
  const installs = remix
    ? await addDependency(
        stage,
        "@remix-run/cloudflare",
        // Remix packages must share a version.
        dependencies["@remix-run/node"] ?? dependencies["@remix-run/react"] ?? VERSIONS["@remix-run/cloudflare"],
      )
    : []
  await mkdir(path.join(stage, ".omai"), { recursive: true })
  await writeFile(path.join(stage, ".omai", "worker.mjs"), routerWorker(remix ? "@remix-run/cloudflare" : "react-router"))
  // The framework's default entry.server renders with Node streams (`renderToPipeableStream`), which the Workers bundle
  // of react-dom doesn't have. A project without its own gets a Web-streams one in the stage.
  const app = await appDirectory(stage)
  const own = (await readdir(path.join(stage, app)).catch(() => [])).find((name) => ENTRY_SERVER.test(name))
  if (own && NODE_STREAMS.test(await readFile(path.join(stage, app, own), "utf8")))
    throw new Unsupported(
      `Publishing needs an entry.server that renders with Web streams (renderToReadableStream). ${path.posix.join(app, own)} uses Node streams; switch it to renderToReadableStream, or delete it to use the default.`,
    )
  if (own) return { installs, env: {} }
  await mkdir(path.join(stage, app), { recursive: true })
  await writeFile(path.join(stage, app, "entry.server.js"), entryServer(remix))
  return { installs: [...installs, ...(await addDependency(stage, "isbot", VERSIONS.isbot))], env: {} }
}

/**
 * Fixes build output that runs locally but not in a dispatch namespace. Only the stage is written; `main` is the worker
 * entry the generated wrangler config names.
 */
export async function finish(kind: Publish.Kind, main: string | undefined) {
  if (kind !== "sveltekit" || !main) return
  // adapter-cloudflare 7.x (Kit 2) caches responses in `caches.default`, which a dispatched Worker may not use: every
  // request throws "This Worker is not permitted to access the default cache.". An empty cache serves everything
  // uncached, as 8.x does.
  const text = await readFile(main, "utf8")
  const patched = text.replace(
    /\bvar (\w+) = caches\.default;/,
    "var $1 = { match: async () => undefined, put: async () => {} };",
  )
  if (patched !== text) await writeFile(main, patched)
}

const ENTRY_SERVER = /^entry\.server\.(?:js|jsx|ts|tsx|mjs|mts)$/
const NODE_STREAMS = /renderToPipeableStream|["'](?:node:)?stream["']/

// `appDirectory` from the React Router config, or the Remix plugin options in vite.config; `app` by default.
async function appDirectory(stage: string) {
  const files = [await configFile(stage, "react-router.config"), await configFile(stage, "vite.config")]
  const texts = await Promise.all(files.map((file) => (file ? readFile(file, "utf8") : "")))
  return /appDirectory\s*:\s*["']([^"']+)["']/.exec(texts.join("\n"))?.[1]?.replace(/^\.\//, "") ?? "app"
}

// React Router's Cloudflare template entry, without JSX so it builds whatever the project's JSX setup.
function entryServer(remix: boolean) {
  const server = remix ? "RemixServer" : "ServerRouter"
  return `import { createElement } from "react"
import { renderToReadableStream } from "react-dom/server"
import { isbot } from "isbot"
import { ${server} } from "${remix ? "@remix-run/react" : "react-router"}"

export default async function handleRequest(request, responseStatusCode, responseHeaders, routerContext) {
  let shellRendered = false
  const userAgent = request.headers.get("user-agent")
  const body = await renderToReadableStream(createElement(${server}, { context: routerContext, url: request.url }), {
    signal: request.signal,
    onError(error) {
      responseStatusCode = 500
      if (shellRendered) console.error(error)
    },
  })
  shellRendered = true
  if ((userAgent && isbot(userAgent)) || routerContext.isSpaMode) await body.allReady
  responseHeaders.set("Content-Type", "text/html")
  return new Response(body, { headers: responseHeaders, status: responseStatusCode })
}
`
}

/**
 * The adapter version for a project's `@sveltejs/kit`: the major of the declared range, or of the installed copy when
 * the range names none (`latest`, `file:`, `workspace:*`). Kit 3 is assumed when neither tells.
 */
export function svelteAdapter(declared: string | undefined, installed?: string) {
  return major(declared, installed) === 2 ? SVELTE_ADAPTERS[2] : SVELTE_ADAPTERS[3]
}

/** The adapter version for a project's `astro`, chosen like `svelteAdapter`; undefined before Astro 6. Astro 7 when unknown. */
export function astroAdapter(declared: string | undefined, installed?: string) {
  const found = major(declared, installed) ?? 7
  if (found < 6) return undefined
  return found === 6 ? ASTRO_ADAPTERS[6] : ASTRO_ADAPTERS[7]
}

// The major of a declared range, or of the installed version when the range names none.
function major(declared: string | undefined, installed: string | undefined) {
  const found = /^\D*(\d+)/.exec(declared ?? "")?.[1] ?? /^(\d+)\./.exec(installed ?? "")?.[1]
  return found === undefined ? undefined : Number(found)
}

// The stage keeps node_modules from the previous publish, so a project published before has its packages there.
async function installed(stage: string, name: string): Promise<string | undefined> {
  return readFile(path.join(stage, "node_modules", name, "package.json"), "utf8")
    .then((text) => JSON.parse(text).version)
    .catch(() => undefined)
}

const OPEN_NEXT_CONFIG = `import { defineCloudflareConfig } from "@opennextjs/cloudflare"

export default defineCloudflareConfig()
`

// Static files are served from the `build/client` assets binding before the worker runs, so it only renders routes.
function routerWorker(runtime: string) {
  return `import { createRequestHandler } from "${runtime}"
import * as build from "../build/server/index.js"

const handler = createRequestHandler(build, "production")

export default {
  fetch(request, env, ctx) {
    return handler(request, { cloudflare: { env, ctx } })
  },
}
`
}

/** Rewrites an Astro config to use `@astrojs/cloudflare`, replacing any other adapter. */
function useAstroCloudflare(text: string, file: string) {
  const imports = text.replace(
    /^[ \t]*import\s+[\w$]+\s+from\s+["']@astrojs\/(?:node|vercel|netlify|cloudflare|deno)(?:\/[\w-]+)?["'];?[ \t]*\r?\n?/gm,
    "",
  )
  const existing = /\badapter\s*:\s*/.exec(imports)
  const configured = existing
    ? imports.slice(0, existing.index + existing[0].length) +
      "cloudflare()" +
      imports.slice(expressionEnd(imports, existing.index + existing[0].length))
    : imports.replace(/(defineConfig\(\s*\{|export\s+default\s*\{)/, "$1\n  adapter: cloudflare(),\n")
  if (configured === imports && !existing)
    throw new Error(`O M A I + couldn't add the Cloudflare adapter to ${file}. Set \`adapter\` in its exported config.`)
  return `import cloudflare from "@astrojs/cloudflare"\n${configured}`
}

// The end of the expression starting at `start`: the first top-level `,`, or the bracket closing its container.
function expressionEnd(text: string, start: number) {
  const close = new Set([")", "]", "}"])
  let depth = 0
  let quote = ""
  for (let index = start; index < text.length; index++) {
    const char = text[index]
    if (quote) {
      if (char === "\\") index++
      if (char === quote) quote = ""
      continue
    }
    if (char === '"' || char === "'" || char === "`") quote = char
    if (char === "(" || char === "[" || char === "{") depth++
    if (close.has(char) && depth === 0) return index
    if (close.has(char)) depth--
    if (char === "," && depth === 0) return index
  }
  return text.length
}

// The first config file with this base name, whatever its extension.
async function configFile(stage: string, base: string) {
  const name = (await readdir(stage)).find((entry) => entry.startsWith(`${base}.`))
  return name ? path.join(stage, name) : undefined
}

async function packageDependencies(stage: string): Promise<Record<string, string>> {
  const json = JSON.parse(await readFile(path.join(stage, "package.json"), "utf8"))
  return { ...json.dependencies, ...json.devDependencies }
}

/** Adds a dev dependency to the stage package.json unless the project already has it, and returns what was added. */
async function addDependency(stage: string, name: string, version: string) {
  const file = path.join(stage, "package.json")
  const json = JSON.parse(await readFile(file, "utf8"))
  if (json.dependencies?.[name] || json.devDependencies?.[name]) return []
  json.devDependencies = { ...json.devDependencies, [name]: version }
  await writeFile(file, JSON.stringify(json, null, 2) + "\n")
  return [`${name}@${version}`]
}
