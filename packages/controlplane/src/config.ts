import path from "node:path"
import { fileURLToPath } from "node:url"
import { Option, Schema } from "effect"
import { PublishConfig } from "@opencode/core/publish/config"

export * as ControlPlaneConfig from "./config.js"

export type Config = ReturnType<typeof fromEnv>

const REQUIRED = ["OMAI_APP_ORIGIN", "OMAI_TOKEN_SIGNING_KEY", "OMAI_TOKEN_PUBLIC_KEY", "OMAI_ROUTER_URL"] as const

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url))
const decodeCommand = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Array(Schema.String)))

export function fromEnv(env: Record<string, string | undefined>) {
  // The env files keep empty placeholders such as `OMAI_DATABASE_URL=`, so empty means unset.
  const read = (name: string) => (env[name] === "" ? undefined : env[name])
  const missing = REQUIRED.filter((name) => !read(name))
  if (missing.length > 0) throw new Error(`Missing control plane configuration: ${missing.join(", ")}`)
  const dataDir = path.resolve(read("OMAI_CONTROLPLANE_DATA_DIR") ?? ".omai-controlplane")
  const provider = read("OMAI_VM_PROVIDER") ?? "local"
  if (provider !== "local" && provider !== "northflank")
    throw new Error(`OMAI_VM_PROVIDER must be "local" or "northflank", got "${provider}"`)
  const appOrigin = read("OMAI_APP_ORIGIN")!
  const platformUrl = read("OMAI_PLATFORM_URL")
  if (platformUrl && !URL.parse(platformUrl)?.port) throw new Error("OMAI_PLATFORM_URL must name a port, e.g. http://controlplane:4102")
  return {
    databaseUrl: read("OMAI_DATABASE_URL"),
    dataDir,
    appOrigin,
    port: number(read("OMAI_CONTROLPLANE_PORT"), 4100),
    internalPort: number(read("OMAI_CONTROLPLANE_INTERNAL_PORT"), 4101),
    /** Internal routes listen here: loopback locally, the private network address in production. */
    internalHost: read("OMAI_CONTROLPLANE_INTERNAL_HOST") ?? "127.0.0.1",
    signingKey: read("OMAI_TOKEN_SIGNING_KEY")!,
    publicKey: read("OMAI_TOKEN_PUBLIC_KEY")!,
    routerUrl: read("OMAI_ROUTER_URL")!.replace(/\/+$/, ""),
    /** How a VM reaches the internal routes; loopback (the local provider's VMs share the machine) when unset. */
    controlPlaneVmUrl: read("OMAI_CONTROL_PLANE_VM_URL")?.replace(/\/+$/, ""),
    /**
     * Where the router reaches the platform server, e.g. the control plane's private address on another port. When set,
     * the platform server listens on all interfaces at that port; otherwise on loopback, for a router on the same machine.
     */
    platformUrl: platformUrl?.replace(/\/+$/, ""),
    signupEnabled: read("OMAI_SIGNUP_ENABLED") === "true",
    vmProvider: provider as "local" | "northflank",
    northflank: provider === "northflank" ? northflank(read, appOrigin) : undefined,
    /** The port a VM's preview listens on, which Northflank publishes. */
    previewPort: number(read("OMAI_PREVIEW_PORT"), 4097),
    localProjectsRoot: path.resolve(read("OMAI_LOCAL_PROJECTS_ROOT") ?? path.join(dataDir, "vms")),
    localServeCommand: command(read("OMAI_LOCAL_SERVE_COMMAND")),
    sessionIdleMs: number(read("OMAI_SESSION_IDLE_MS"), 900_000),
    vmWakeTimeoutMs: number(read("OMAI_VM_WAKE_TIMEOUT_MS"), 90_000),
    /** A VM with no activity for this long, and not busy, is paused. */
    vmIdleMs: number(read("OMAI_VM_IDLE_MS"), 120_000),
    vmSweepMs: number(read("OMAI_VM_SWEEP_MS"), 15_000),
    /** A pushed busy report older than this is ignored and the VM is asked directly. */
    vmBusyFreshMs: number(read("OMAI_VM_BUSY_FRESH_MS"), 30_000),
    /** An idle VM that can't be reached is paused once it has been unreachable this long. */
    vmUnreachableGraceMs: number(read("OMAI_VM_UNREACHABLE_GRACE_MS"), 60_000),
    vmReconcileMs: number(read("OMAI_VM_RECONCILE_MS"), 180_000),
    /**
     * Reserve VMs kept booted for each active user, so a new project opens at once. 0 (the default) turns reserves
     * off. Set it only on the deployed control plane: reserves are real, billed VMs.
     */
    vmReservesPerUser: Math.max(0, Math.floor(number(read("OMAI_VM_RESERVES_PER_USER"), 0))),
    /** A user's reserves are deleted after this long with no activity and no project VM running. */
    vmReserveIdleMs: number(read("OMAI_VM_RESERVE_IDLE_MS"), 600_000),
    /** The most reserves across all users, so many visitors at once cannot boot an unbounded number of VMs. */
    vmReservesMax: Math.max(0, Math.floor(number(read("OMAI_VM_RESERVES_MAX"), 20))),
    zipMaxBytes: number(read("OMAI_ZIP_MAX_BYTES"), 500 * 1024 * 1024),
    /** Cloudflare for publishing; undefined when unset. Only the control plane ever holds it, never a VM. */
    cloudflare: PublishConfig.read(env),
    /** The largest publish upload a VM may send. */
    publishMaxBytes: number(read("OMAI_PUBLISH_MAX_BYTES"), 300 * 1024 * 1024),
    /** Uploads to Cloudflare running at once across all projects; more wait their turn. */
    publishConcurrency: number(read("OMAI_PUBLISH_CONCURRENCY"), 4),
  }
}

const NORTHFLANK_REQUIRED = ["OMAI_NORTHFLANK_API_TOKEN", "OMAI_NORTHFLANK_PROJECT", "OMAI_NORTHFLANK_IMAGE"] as const

function northflank(read: (name: string) => string | undefined, appOrigin: string) {
  const missing = NORTHFLANK_REQUIRED.filter((name) => !read(name))
  if (missing.length > 0) throw new Error(`Missing Northflank configuration: ${missing.join(", ")}`)
  const project = read("OMAI_NORTHFLANK_PROJECT")!
  // The old production app lives in project `omai`; nothing here may ever act on it.
  if (project.toLowerCase() === "omai") throw new Error('OMAI_NORTHFLANK_PROJECT must not be "omai" (the old production app)')
  const prefix = read("OMAI_NORTHFLANK_NAME_PREFIX") ?? "omai"
  // Volume names are at most 39 characters; this leaves at least 22 characters of the project ID in them.
  if (!/^[a-z][a-z0-9-]{0,11}$/.test(prefix))
    throw new Error("OMAI_NORTHFLANK_NAME_PREFIX must be 1 to 12 lowercase letters, digits or dashes")
  const publicVms = read("OMAI_NORTHFLANK_PUBLIC_VMS") === "true"
  // A public API port lets a router on a laptop reach the VM (testing only); the VM's own password still guards it.
  if (publicVms && !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(appOrigin))
    throw new Error("OMAI_NORTHFLANK_PUBLIC_VMS is for local testing only: OMAI_APP_ORIGIN must be a localhost origin")
  // A VM's loopback is not the control plane. Only a laptop test (public VMs) may run without it, losing model keys,
  // publishing and the preview address.
  if (!publicVms && !read("OMAI_CONTROL_PLANE_VM_URL"))
    throw new Error("Missing Northflank configuration: OMAI_CONTROL_PLANE_VM_URL (the control plane's private address)")
  return {
    apiBase: read("OMAI_NORTHFLANK_API_BASE") ?? "https://api.northflank.com/v1",
    token: read("OMAI_NORTHFLANK_API_TOKEN")!,
    project,
    image: read("OMAI_NORTHFLANK_IMAGE")!,
    plan: read("OMAI_NORTHFLANK_PLAN") ?? "nf-compute-100-4",
    // Northflank's smallest volume is 6 GB.
    volumeSizeGb: Math.max(number(read("OMAI_NORTHFLANK_VOLUME_SIZE_GB"), 10), 6),
    prefix,
    publicVms,
  }
}

function number(value: string | undefined, fallback: number) {
  if (value === undefined) return fallback
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) throw new Error(`Expected a number, got "${value}"`)
  return parsed
}

function command(value: string | undefined) {
  if (value === undefined) return ["bun", path.join(repoRoot, "packages/cli/src/index.ts"), "serve"]
  return Option.getOrThrowWith(
    decodeCommand(value),
    () => new Error("OMAI_LOCAL_SERVE_COMMAND must be a JSON string array"),
  )
}
