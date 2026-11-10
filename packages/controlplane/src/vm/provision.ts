import { createHash, randomBytes } from "node:crypto"
import { and, eq } from "drizzle-orm"
import { SignedToken } from "@opencode/util/signed-token"
import type { Config } from "../config.js"
import type { Db } from "../db/database.js"
import { ProjectTable, UserTable } from "../db/schema.js"
import type { VmLabel, VmProvider } from "./provider.js"

const VM_TOKEN_TTL_SECONDS = 12 * 60 * 60

export function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex")
}

export function vmToken(
  config: Pick<Config, "signingKey">,
  input: { userID: string; projectID: string; sessionID: string; host: string },
  now = Date.now(),
) {
  return SignedToken.sign(
    {
      typ: "vm",
      sub: input.userID,
      pid: input.projectID,
      sid: input.sessionID,
      host: input.host,
      exp: Math.floor(now / 1000) + VM_TOKEN_TTL_SECONDS,
    },
    config.signingKey,
  )
}

type Labelled = { id: string; user_id: string; name: string; reserved_at: Date | null; vm_id?: string | null }

/** What the provider's console shows for a project's VM: a reserve has no project name yet. */
export async function label(db: Db, project: Labelled): Promise<VmLabel> {
  const user = (await db.select({ username: UserTable.username }).from(UserTable).where(eq(UserTable.id, project.user_id)))[0]
  const userName = user?.username ?? project.user_id
  if (project.reserved_at) return { type: "reserve", userName }
  return { type: "vm", projectName: project.name, userName }
}

/** Brings a running VM's label up to date. Only a label, so a failure (Northflank refusing a paused VM, say) is logged. */
export function relabel(db: Db, provider: VmProvider, project: Labelled) {
  const vmID = project.vm_id
  if (!vmID) return
  void label(db, project)
    .then((value) => provider.label(vmID, project.id, value))
    .catch((error: unknown) => console.error(`labelling the VM of ${project.id} failed`, error))
}

/**
 * Creates the project's VM with a fresh project token and waits until its server answers.
 * Ends with the project `running`, or `failed` with the reason.
 */
export async function provision(
  db: Db,
  config: Config,
  provider: VmProvider,
  project: Labelled & { slug: string },
  now = () => Date.now(),
) {
  const token = randomBytes(32).toString("base64url")
  const result = await db
    .update(ProjectTable)
    .set({ project_token_hash: hashToken(token) })
    .where(and(eq(ProjectTable.id, project.id), eq(ProjectTable.vm_state, "creating")))
    .then(() => label(db, project))
    .then((value) =>
      provider.create({
        projectID: project.id,
        slug: project.slug,
        label: value,
        env: {
          OMAI_PROJECT_ID: project.id,
          // A reserve has no folder name yet; its VM asks the control plane once the reserve is claimed.
          ...(project.slug ? { OMAI_PROJECT_SLUG: project.slug } : {}),
          OMAI_PROJECT_TOKEN: token,
          OMAI_CONTROL_PLANE_URL: config.controlPlaneVmUrl ?? `http://127.0.0.1:${config.internalPort}`,
          OMAI_TOKEN_PUBLIC_KEY: config.publicKey,
        },
      }),
    )
    .then(async (address) => {
      // Recorded at once: the VM asks for its preview address while it starts, and a VM that never answers must still
      // be known to the row, so reconcile and a later pause can act on it.
      await db
        .update(ProjectTable)
        .set({
          vm_id: address.vmID,
          vm_host: address.host,
          vm_home: address.home,
          vm_preview: address.preview ?? null,
        })
        .where(and(eq(ProjectTable.id, project.id), eq(ProjectTable.vm_state, "creating")))
      // A reserve claimed while it booted was created with the reserve label.
      if (project.reserved_at) {
        const current = (await db.select().from(ProjectTable).where(eq(ProjectTable.id, project.id)))[0]
        if (current && !current.reserved_at) relabel(db, provider, current)
      }
      await waitReady(config, { userID: project.user_id, projectID: project.id, host: address.host }).catch(
        async (error: unknown) => {
          // A real VM bills while it runs; a retry starts it again.
          await provider.stop(address.vmID).catch((stopError: unknown) => console.error(`stopping ${project.id} failed`, stopError))
          throw error
        },
      )
      return address
    })
    .then(
      (address) => ({ ok: true as const, address }),
      (error: unknown) => ({ ok: false as const, error: error instanceof Error ? error.message : String(error) }),
    )
  await db
    .update(ProjectTable)
    .set(
      result.ok
        ? {
            vm_state: "running",
            vm_id: result.address.vmID,
            vm_host: result.address.host,
            vm_home: result.address.home,
            vm_preview: result.address.preview ?? null,
            vm_error: null,
            last_activity_at: new Date(now()),
          }
        : { vm_state: "failed", vm_error: result.error },
    )
    .where(and(eq(ProjectTable.id, project.id), eq(ProjectTable.vm_state, "creating")))
}

/** Polls `GET <host>/api/info` every 500 ms until it answers 200, or throws after `vmWakeTimeoutMs`. */
export async function waitReady(
  config: Pick<Config, "signingKey" | "vmWakeTimeoutMs">,
  input: { userID: string; projectID: string; host: string },
) {
  const authorization = `Basic ${Buffer.from(`omai:${vmToken(config, { ...input, sessionID: "control-plane" })}`).toString("base64")}`
  const deadline = Date.now() + config.vmWakeTimeoutMs
  for (;;) {
    const status = await fetch(`${input.host}/api/info`, {
      headers: { authorization },
      signal: AbortSignal.timeout(2000),
    }).then(
      (res) => res.status,
      () => 0,
    )
    if (status === 200) return
    if (Date.now() >= deadline)
      throw new Error(`The project's server did not start within ${config.vmWakeTimeoutMs / 1000} s`)
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
}
