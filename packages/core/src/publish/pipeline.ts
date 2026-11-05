export * as PublishPipeline from "./pipeline.js"

import type { Publish } from "@opencode/schema/publish"
import { accessSync, constants } from "node:fs"
import { access, mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { directoryTree } from "../preview/controller.js"
import { packageManager } from "../preview/detect.js"
import { fingerprint, install, installCommand } from "../preview/install.js"
import { LogBuffer, spawnGroup } from "../preview/process.js"
import { adapt, buildEnv, finish, Unsupported } from "./adapt.js"
import type { Config } from "./config.js"
import { detectKind } from "./detect.js"
import { clean, staticAssets, sync } from "./stage.js"
import { deployArgs, ensureWrangler, wranglerConfig } from "./wrangler.js"

export const BUILD_TIMEOUT = 900_000
export const UPLOAD_TIMEOUT = 300_000
/** The log kept with a deploy. */
export const LOG_TAIL = 64 * 1024

/** Output directories each server kind writes, deleted before every build so stale files are never uploaded. */
const SERVER_OUTPUTS: Record<string, string[]> = {
  next: [".open-next", ".next"],
  nuxt: [".output"],
  solidstart: [".output"],
  sveltekit: [".svelte-kit"],
  "astro-server": ["dist"],
  "react-router": ["build", ".omai"],
}

/** A publish that did not go live: a plain reason, and the tail of the output. */
export class PublishFailure extends Error {
  constructor(
    readonly kind: Publish.FailureKind,
    message: string,
    readonly log: string,
  ) {
    super(message)
    this.name = "PublishFailure"
  }
}

/** Where a project's publish files live: the stage, the generated wrangler config and the install record. */
export const projectDir = (dataDir: string, projectID: string) => path.join(dataDir, "publish", projectID)

/**
 * Builds the project at `directory` in its staging copy and uploads it as the script `name`. The project directory is
 * only read. Throws `PublishFailure`; a cancelled run throws one too, after `signal` aborted.
 */
export async function run(input: {
  projectID: string
  directory: string
  /** The global data directory. */
  dataDir: string
  name: string
  config: Config
  /** No version of the site is live yet, so a failed upload leaves nothing serving. */
  first?: boolean
  signal: AbortSignal
  onStage: (stage: Publish.Stage) => void
  onLog: (chunk: string) => void
}): Promise<{ kind: Publish.Kind }> {
  const log = new LogBuffer()
  const onLog = (chunk: string) => {
    log.append(chunk)
    input.onLog(chunk)
  }
  const fail = (kind: Publish.FailureKind, message: string): never => {
    throw new PublishFailure(kind, message, log.tail(LOG_TAIL))
  }
  const checkpoint = () => {
    if (input.signal.aborted) fail("other", "The publish was cancelled.")
  }
  const home = projectDir(input.dataDir, input.projectID)
  const stage = path.join(home, "stage")

  input.onStage("prepare")
  const detected = await detectKind(input.directory)
  if ("error" in detected) return fail("unsupported", detected.error)
  onLog(`Publishing a ${detected.framework} project as ${detected.kind}.\n`)
  await sync(input.directory, stage)
  await clean(stage, outputs(detected.kind, detected.output))
  const adapted = await adapt(stage, detected.kind).catch((error: unknown) =>
    fail(error instanceof Unsupported ? "unsupported" : "other", error instanceof Error ? error.message : String(error)),
  )
  checkpoint()

  if (detected.kind !== "static" && (await exists(path.join(stage, "package.json")))) {
    input.onStage("install")
    const installed = await installStage({ home, stage, signal: input.signal, onLog })
    checkpoint()
    if (!installed.ok) return fail("other", installed.reason)
  }

  const build = adapted.build ?? detected.build
  if (detected.kind !== "static" && build) {
    input.onStage("build")
    onLog(`$ ${build}\n`)
    const code = await exec({
      command: build,
      cwd: stage,
      env: buildEnv(process.env, adapted.env),
      timeout: BUILD_TIMEOUT,
      signal: input.signal,
      onLog,
    })
    checkpoint()
    if (code === "timeout") return fail("other", `The build took longer than ${BUILD_TIMEOUT / 60_000} minutes.`)
    if (code !== 0) return fail("other", `\`${build}\` failed${code === null ? "" : ` with exit code ${code}`}.`)
  }

  input.onStage("upload")
  const generated = wranglerConfig(detected.kind, {
    name: input.name,
    stage,
    output: await uploadDirectory(stage, detected.kind, detected.output),
  })
  const main = "main" in generated ? generated.main : undefined
  // The paths the upload reads come from the generated config: the assets directory and a server kind's worker entry.
  const required = [generated.assets.directory, ...(main ? [main] : [])]
  const missing = (await Promise.all(required.map(exists))).indexOf(false)
  if (missing !== -1)
    return fail("other", `The build finished but didn't write ${path.relative(stage, required[missing])}.`)
  await finish(detected.kind, main)
  // The static kind's directory is already filtered; build output is uploaded as written, so secrets are ignored.
  if (detected.kind !== "static") await ignoreAssets(generated.assets.directory, main)
  const config = path.join(home, "wrangler.json")
  await writeFile(config, JSON.stringify(generated, null, 2) + "\n")
  const wrangler = await ensureWrangler(path.join(input.dataDir, "publish", "tools")).catch((error: unknown) =>
    fail("cloudflare", error instanceof Error ? error.message : String(error)),
  )
  checkpoint()
  const args = deployArgs({ name: input.name, namespace: input.config.namespace, config })
  onLog(`$ wrangler ${args.join(" ")}\n`)
  const code = await exec({
    command: [wrangler, ...args].map(quote).join(" "),
    // Not the stage: it holds the project's own files, such as `.env`, which wrangler would read from its working
    // directory. The home holds the generated config, whose paths are all absolute.
    cwd: home,
    // Wrangler's own variable names; only this step gets the credentials.
    env: {
      ...buildEnv(),
      CLOUDFLARE_API_TOKEN: input.config.token,
      CLOUDFLARE_ACCOUNT_ID: input.config.accountID,
      WRANGLER_SEND_METRICS: "false",
    },
    timeout: UPLOAD_TIMEOUT,
    signal: input.signal,
    onLog,
  })
  // No cancel checkpoint here: once wrangler exited 0 the new version is live, so a late cancel can't undo it.
  if (code === "timeout") return fail("cloudflare", `The upload took longer than ${UPLOAD_TIMEOUT / 60_000} minutes.`)
  if (code !== 0)
    return fail(
      "cloudflare",
      input.first
        ? "The upload to Cloudflare failed. Nothing was published."
        : "The upload to Cloudflare failed. The previous version is still live.",
    )
  return { kind: detected.kind }
}

function outputs(kind: Publish.Kind, output: string | undefined) {
  // Angular's `<path>/browser` is a guess made before the build, so its parent goes too.
  const own = output ? [output.endsWith("/browser") ? path.posix.dirname(output) : output] : []
  return [...own, ...(SERVER_OUTPUTS[kind] ?? [])]
}

/** The upload's static directory relative to the stage; undefined for server kinds, whose config names its own. */
async function uploadDirectory(stage: string, kind: Publish.Kind, output: string | undefined) {
  if (kind === "static") return path.relative(stage, await staticAssets(stage))
  // Older Angular builders write the site to outputPath itself, not to its `browser` folder.
  const parent = output?.endsWith("/browser") ? path.posix.dirname(output) : undefined
  if (output && parent && !(await exists(path.join(stage, output))) && (await exists(path.join(stage, parent))))
    return parent
  return output
}

/**
 * Appends to the `.assetsignore` wrangler reads in the assets directory, which is build output inside the stage (a
 * user's own `.assetsignore` from `public/` is kept). `.env*` copied from `public/` must never be served, and a worker
 * entry written inside the assets directory (SvelteKit's `_worker.js`) is server code, not an asset.
 */
async function ignoreAssets(directory: string, main: string | undefined) {
  const file = path.join(directory, ".assetsignore")
  const existing = await readFile(file, "utf8").catch(() => "")
  const entry = main && main.startsWith(directory + path.sep) ? path.relative(directory, main).split(path.sep).join("/") : undefined
  const lines = [".env*", ...(entry ? [`/${entry}`, "/_routes.json"] : [])]
  await writeFile(file, `${existing}${existing && !existing.endsWith("\n") ? "\n" : ""}${lines.join("\n")}\n`)
}

/**
 * Installs the stage's packages unless the same package.json and lockfile installed fine last time. The record lives
 * outside the stage because the stage's lockfile is rewritten by every sync.
 */
async function installStage(input: { home: string; stage: string; signal: AbortSignal; onLog: (chunk: string) => void }) {
  const current = await fingerprint(input.stage)
  const record = path.join(input.home, "install.json")
  const previous = await readFile(record, "utf8").catch(() => "")
  if (previous === current && (await exists(path.join(input.stage, "node_modules")))) {
    input.onLog("Packages are up to date.\n")
    return { ok: true as const }
  }
  const pm = await packageManager(directoryTree(input.stage), ".")
  // devDependencies hold the bundlers and adapters, so the install must not run with NODE_ENV=production.
  const env = Object.fromEntries(Object.entries(buildEnv()).filter((entry) => entry[0] !== "NODE_ENV"))
  const chosen = installCommand(pm, (bin) => available(bin, env.PATH))
  if (chosen.note) input.onLog(`${chosen.note}\n`)
  input.onLog(`$ ${chosen.command}\n`)
  // npm creates no node_modules for a package without dependencies, and the install records into it.
  await mkdir(path.join(input.stage, "node_modules"), { recursive: true })
  const installed = await install({
    root: input.stage,
    command: chosen.command,
    retry: chosen.retry,
    env: { ...env, ...chosen.env },
    onLog: input.onLog,
    signal: input.signal,
  })
  if (installed.ok) await writeFile(record, current)
  return installed
}

/** Runs `command` in its own process group; the group is killed on abort or after `timeout`. */
async function exec(input: {
  command: string
  cwd: string
  env: Record<string, string>
  timeout: number
  signal: AbortSignal
  onLog: (chunk: string) => void
}) {
  if (input.signal.aborted) return null
  const running = spawnGroup({ command: input.command, cwd: input.cwd, env: input.env, onLog: input.onLog })
  const stop = () => void running.stop()
  input.signal.addEventListener("abort", stop, { once: true })
  const state = { timedOut: false }
  const timer = setTimeout(() => {
    state.timedOut = true
    stop()
  }, input.timeout)
  const code = await running.exited
  clearTimeout(timer)
  input.signal.removeEventListener("abort", stop)
  return state.timedOut ? ("timeout" as const) : code
}

function available(bin: string, searchPath: string | undefined) {
  return (searchPath ?? "").split(path.delimiter).some((dir) => {
    try {
      accessSync(path.join(dir, bin), constants.X_OK)
      return true
    } catch {
      return false
    }
  })
}

const exists = (target: string) => access(target).then(
  () => true,
  () => false,
)

const quote = (arg: string) => `'${arg.replaceAll("'", `'\\''`)}'`
