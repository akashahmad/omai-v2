// Installs a project's packages when they are missing, stale or broken, and never trusts a failed install.

import { createHash } from "node:crypto"
import { readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import type { PackageManager } from "./detect.js"
import { INSTALL_TIMEOUT } from "./limits.js"
import { LogBuffer, spawnGroup } from "./process.js"

const RECORD = ".omai-preview.json"

const LOCKFILES = ["bun.lock", "bun.lockb", "pnpm-lock.yaml", "yarn.lock", "package-lock.json"]

// A project's engine-strict setting is for its own development; a preview would rather run on an untested Node than
// refuse to install.
const COMMANDS: Record<PackageManager, string> = {
  npm: "npm install --no-audit --no-fund --engine-strict=false",
  pnpm: "pnpm install --no-frozen-lockfile --config.engine-strict=false",
  yarn: "yarn install",
  bun: "bun install",
}

// The clean retry also stops peer-dependency resolution from failing the install: npm's resolver gives up, or crashes,
// on peer conflicts that the project runs fine with.
const RELAXED: Record<PackageManager, string> = {
  npm: " --legacy-peer-deps",
  pnpm: " --config.strict-peer-dependencies=false",
  yarn: "",
  bun: "",
}

/**
 * The install command for a package manager, and the relaxed one its retry uses. One that is not on PATH runs through corepack when that exists;
 * otherwise npm installs, which ignores the project's lockfile, and `note` says so.
 */
export function installCommand(
  pm: PackageManager,
  available: (bin: string) => boolean,
): { command: string; retry: string; env: Record<string, string>; note?: string } {
  const env: Record<string, string> = pm === "yarn" ? { YARN_ENABLE_IMMUTABLE_INSTALLS: "false" } : {}

  if (available(pm)) return { command: COMMANDS[pm], retry: COMMANDS[pm] + RELAXED[pm], env }

  if (pm !== "npm" && available("corepack"))
    return { command: `corepack ${COMMANDS[pm]}`, retry: `corepack ${COMMANDS[pm]}${RELAXED[pm]}`, env }

  return {
    command: COMMANDS.npm,
    retry: COMMANDS.npm + RELAXED.npm,
    env: {},
    note: `${pm} isn't installed, so npm installs the packages and ${pm}'s lockfile is not used.`,
  }
}

/** A hash of what decides the installed packages: package.json and the lockfile beside it. */
export async function fingerprint(root: string) {
  const hash = createHash("sha256")
  hash.update((await readFile(path.join(root, "package.json")).catch(() => "")) || "")

  for (const name of LOCKFILES) {
    const lock = await readFile(path.join(root, name)).catch(() => undefined)

    if (!lock) continue
    hash.update(name)
    hash.update(lock)
    break
  }

  return hash.digest("hex")
}

/** Whether `root` needs an install: no successful install is recorded, or it was for different packages. */
export async function needsInstall(root: string, current: string) {
  const record = await readFile(path.join(root, "node_modules", RECORD), "utf8").catch(() => undefined)

  if (!record) return true

  try {
    return (JSON.parse(record) as { fingerprint?: unknown }).fingerprint !== current
  } catch {
    return true
  }
}

export type Installed = { ok: true } | { ok: false; reason: string; log: string }

/**
 * Runs the install in `root`. A failure is retried once after removing node_modules; success records the
 * fingerprint in node_modules, so deleting node_modules forgets it.
 */
export async function install(input: {
  root: string
  command: string
  /** The command the retry runs; the same command by default. */
  retry?: string
  env: Record<string, string>
  onLog: (chunk: string) => void
  signal: AbortSignal
}): Promise<Installed> {
  const log = new LogBuffer()
  const onLog = (chunk: string) => {
    log.append(chunk)
    input.onLog(chunk)
  }
  const first = await attempt(input, onLog)

  if (first === "ok") return record(input.root)

  if (first === "aborted") return { ok: false, reason: "The install was cancelled.", log: log.text() }
  onLog("\nThe install failed. Removing node_modules and trying once more.\n")
  await rm(path.join(input.root, "node_modules"), { recursive: true, force: true })
  const second = await attempt({ ...input, command: input.retry ?? input.command }, onLog)

  if (second === "ok") return record(input.root)

  return {
    ok: false,
    reason: second === "aborted" ? "The install was cancelled." : `\`${input.retry ?? input.command}\` failed.`,
    log: log.text(),
  }
}

async function record(root: string): Promise<Installed> {
  await writeFile(
    path.join(root, "node_modules", RECORD),
    JSON.stringify({ fingerprint: await fingerprint(root), at: Date.now() }),
  )

  return { ok: true }
}

async function attempt(
  input: { root: string; command: string; env: Record<string, string>; signal: AbortSignal },
  onLog: (chunk: string) => void,
) {
  if (input.signal.aborted) return "aborted"
  const running = spawnGroup({ command: input.command, cwd: input.root, env: input.env, onLog })
  const stop = () => void running.stop()
  input.signal.addEventListener("abort", stop, { once: true })
  const timer = setTimeout(() => {
    onLog(`\nThe install took longer than ${INSTALL_TIMEOUT / 60_000} minutes.\n`)
    stop()
  }, INSTALL_TIMEOUT)
  const code = await running.exited
  clearTimeout(timer)
  input.signal.removeEventListener("abort", stop)

  if (input.signal.aborted) return "aborted"

  return code === 0 ? "ok" : "failed"
}
