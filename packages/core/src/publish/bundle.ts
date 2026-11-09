export * as PublishBundle from "./bundle.js"

import type { Publish } from "@opencode/schema/publish"
import { access, cp, readdir, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { Zip } from "../files/zip.js"
import { runGroup } from "../preview/process.js"
import { buildEnv } from "./adapt.js"
import type { wranglerConfig } from "./wrangler.js"
import { bundleArgs } from "./wrangler.js"

export const BUNDLE_TIMEOUT = 300_000

/**
 * Packs a built stage for the control plane to upload: `bundle/assets` (the static files) and, for server kinds,
 * `bundle/worker` (the worker as `wrangler deploy --dry-run` bundles it). Wrangler runs here with no Cloudflare
 * variables: bundling needs none, and only the control plane holds them. Throws on a failed bundle.
 */
export async function pack(input: {
  kind: Publish.Kind
  name: string
  /** The project's publish directory; the bundle and zip are written here. */
  home: string
  generated: ReturnType<typeof wranglerConfig>
  wrangler: string
  signal: AbortSignal
  onLog: (chunk: string) => void
}) {
  const root = path.join(input.home, "bundle")
  const zip = path.join(input.home, "bundle.zip")
  await rm(root, { recursive: true, force: true })
  await rm(zip, { force: true })
  await cp(input.generated.assets.directory, path.join(root, "assets"), { recursive: true, dereference: true })
  const main = "main" in input.generated ? input.generated.main : undefined
  const entry = main ? await bundle({ ...input, root, main }) : undefined
  const scanned = await Zip.scan(root, "bundle", input.signal)
  await Zip.write(scanned.entries, zip, () => {}, input.signal)
  return { zip, ...(entry ? { entry } : {}) }
}

async function bundle(input: {
  name: string
  home: string
  root: string
  main: string
  generated: ReturnType<typeof wranglerConfig>
  wrangler: string
  signal: AbortSignal
  onLog: (chunk: string) => void
}) {
  const outdir = path.join(input.root, "worker")
  const config = path.join(input.home, "wrangler.json")
  await writeFile(config, JSON.stringify(input.generated, null, 2) + "\n")
  const args = bundleArgs({ name: input.name, config, outdir })
  input.onLog(`$ wrangler ${args.join(" ")}\n`)
  const code = await runGroup({
    command: [input.wrangler, ...args].map(quote).join(" "),
    // Not the stage: wrangler would read the project's own `.env` from its working directory.
    cwd: input.home,
    env: { ...buildEnv(), WRANGLER_SEND_METRICS: "false" },
    timeout: BUNDLE_TIMEOUT,
    signal: input.signal,
    onLog: input.onLog,
  })
  if (code === "timeout") throw new Error(`Bundling took longer than ${BUNDLE_TIMEOUT / 60_000} minutes.`)
  if (code !== 0) throw new Error("Bundling the site failed.")
  await prune(outdir)
  // A bundled entry is written as `<name>.js`; one uploaded without bundling keeps its own name.
  const candidates = [`${path.parse(input.main).name}.js`, path.basename(input.main)]
  for (const candidate of candidates) if (await exists(path.join(outdir, candidate))) return candidate
  throw new Error("Bundling the site wrote no worker.")
}

/** Drops what the dry run writes beside the modules: its README and source maps. */
async function prune(outdir: string) {
  await rm(path.join(outdir, "README.md"), { force: true })
  const files = await readdir(outdir, { recursive: true, withFileTypes: true })
  await Promise.all(
    files
      .filter((file) => file.isFile() && file.name.endsWith(".map"))
      .map((file) => rm(path.join(file.parentPath, file.name), { force: true })),
  )
}

const exists = (target: string) =>
  access(target).then(
    () => true,
    () => false,
  )

const quote = (arg: string) => `'${arg.replaceAll("'", `'\\''`)}'`
