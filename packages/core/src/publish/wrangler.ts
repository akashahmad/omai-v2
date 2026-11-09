export * as PublishWrangler from "./wrangler.js"

import type { Publish } from "@opencode/schema/publish"
import { execFile } from "node:child_process"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { buildEnv, VERSIONS } from "./adapt.js"
import { STATIC_DIR } from "./stage.js"

/** The wrangler used for uploads, installed once into the tools directory. */
export const WRANGLER_VERSION = VERSIONS.wrangler

const COMPATIBILITY_DATE = "2026-10-01"
const INSTALL_TIMEOUT = 600_000

/**
 * The generated wrangler config. It is built from the kind alone and never merged with the project's own wrangler
 * file, so the project's bindings can't reach the shared account. Paths are absolute inside `stage`; `output` is the
 * uploadable static directory relative to the stage, `.omai-static` by default.
 */
export function wranglerConfig(kind: Publish.Kind, input: { name: string; stage: string; output?: string }) {
  const base = { name: input.name, compatibility_date: COMPATIBILITY_DATE }
  const assets = (handling: string) => ({
    ...base,
    assets: { directory: path.join(input.stage, input.output ?? STATIC_DIR), not_found_handling: handling },
  })
  const server = (main: string, directory: string, flags = ["nodejs_compat"]) => ({
    ...base,
    main: path.join(input.stage, main),
    assets: { directory: path.join(input.stage, directory), binding: "ASSETS" },
    compatibility_flags: flags,
  })

  switch (kind) {
    case "static":
    case "pages":
      return assets("404-page")
    case "spa":
      return assets("single-page-application")
    case "next":
      return server(".open-next/worker.js", ".open-next/assets", ["nodejs_compat", "global_fetch_strictly_public"])
    // The Cloudflare Vite plugin emits an already bundled worker split into chunks, so it is uploaded as is.
    case "astro-server":
      return {
        ...server("dist/server/entry.mjs", "dist/client"),
        no_bundle: true,
        rules: [{ type: "ESModule", globs: ["**/*.js", "**/*.mjs"] }],
      }
    case "nuxt":
    case "solidstart":
      return server(".output/server/index.mjs", ".output/public")
    case "sveltekit":
      return server(".svelte-kit/cloudflare/_worker.js", ".svelte-kit/cloudflare")
    case "react-router":
      return server(".omai/worker.mjs", "build/client")
  }
}

/**
 * The deploy config for an uploaded bundle laid out as `<root>/assets` and `<root>/worker`. Built from the kind alone,
 * like `wranglerConfig`: the worker was already bundled by `bundleArgs`, so it is uploaded as is, and nothing in the
 * upload can add bindings.
 */
export function uploadConfig(kind: Publish.Kind, input: { name: string; root: string; entry?: string }) {
  const local = wranglerConfig(kind, { name: input.name, stage: input.root, output: "assets" })
  const assets = path.join(input.root, "assets")
  if (!("main" in local)) return { ...local, assets: { ...local.assets, directory: assets } }
  const worker = path.join(input.root, "worker")
  return {
    name: local.name,
    compatibility_date: local.compatibility_date,
    main: path.join(worker, input.entry ?? path.basename(local.main)),
    no_bundle: true,
    find_additional_modules: true,
    base_dir: worker,
    rules: [{ type: "ESModule", globs: ["**/*.js", "**/*.mjs"] }],
    assets: { directory: assets, binding: "ASSETS" },
    compatibility_flags: local.compatibility_flags,
  }
}

/** Bundles the worker into `outdir` without uploading; needs no Cloudflare credentials. */
export function bundleArgs(input: { name: string; config: string; outdir: string }) {
  return ["deploy", "--dry-run", "--outdir", input.outdir, "--name", input.name, "--config", input.config]
}

export function deployArgs(input: { name: string; namespace: string; config: string }) {
  return ["deploy", "--dispatch-namespace", input.namespace, "--name", input.name, "--config", input.config]
}

/** Installs running in this process by tools directory, so concurrent first publishes share one npm install. */
const installs = new Map<string, Promise<string>>()

/**
 * Installs the pinned wrangler into `toolsDir` unless that version is already there, and returns its bin. Concurrent
 * calls for one directory share the install; a failed install is not kept, so the next call tries again.
 * `OMAI_PUBLISH_WRANGLER` replaces the bin (tests point it at a fake).
 */
export async function ensureWrangler(toolsDir: string, env: Record<string, string | undefined> = process.env) {
  if (env.OMAI_PUBLISH_WRANGLER) return env.OMAI_PUBLISH_WRANGLER
  const key = path.resolve(toolsDir)
  const running = installs.get(key)
  if (running) return running
  const started = install(toolsDir, env).finally(() => installs.delete(key))
  installs.set(key, started)
  return started
}

async function install(toolsDir: string, env: Record<string, string | undefined>) {
  const bin = path.join(toolsDir, "node_modules", ".bin", "wrangler")
  const installed = await readFile(path.join(toolsDir, "node_modules", "wrangler", "package.json"), "utf8")
    .then((text) => JSON.parse(text).version)
    .catch(() => undefined)
  if (installed === WRANGLER_VERSION) return bin

  await mkdir(toolsDir, { recursive: true })
  // Without its own package.json, npm would install into the nearest parent project.
  await writeFile(path.join(toolsDir, "package.json"), JSON.stringify({ private: true }) + "\n")
  await new Promise<void>((resolve, reject) =>
    execFile(
      "npm",
      ["install", `wrangler@${WRANGLER_VERSION}`, "--no-audit", "--no-fund"],
      { cwd: toolsDir, env: buildEnv(env), timeout: INSTALL_TIMEOUT, maxBuffer: 16 * 1024 * 1024 },
      (error, _stdout, stderr) => {
        if (error) return reject(new Error(`Installing wrangler failed: ${String(stderr).slice(-2000) || error.message}`))
        resolve()
      },
    ),
  )
  return bin
}
