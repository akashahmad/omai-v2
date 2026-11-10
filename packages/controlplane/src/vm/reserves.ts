import { and, asc, eq, gt, inArray, isNotNull, isNull } from "drizzle-orm"
import type { Config } from "../config.js"
import type { Db } from "../db/database.js"
import { AuthSessionTable, ProjectTable, UserTable } from "../db/schema.js"
import { uniqueViolation } from "../users.js"
import type { VmProvider } from "./provider.js"
import { provision } from "./provision.js"

export * as Reserves from "./reserves.js"

export type Reserves = ReturnType<typeof make>

type Row = typeof ProjectTable.$inferSelect

// A reserve whose boot failed holds its user's next one back this long, so a failure that repeats (Northflank refusing
// the volume, say) doesn't boot and delete a VM on every pass.
const RETRY_MS = 300_000
// A reserve still `creating` this long after it was made, with no boot running here, was left by a restart.
const STUCK_MS = 15 * 60_000
const PASS_MS = 30_000

/**
 * Reserve VMs: `vmReservesPerUser` VMs booted ahead for each active user, so creating a project claims one that already
 * runs instead of waiting for a boot. A reserve is a project row with `reserved_at` set, hidden from its user. Its VM
 * knows its project ID and token from the start (so it loads the user's model keys while it waits), and learns its
 * folder name from the control plane once claimed.
 *
 * A user is active while they have a live sign-in seen within `vmReserveIdleMs` (the app pings on clicks, typing and
 * pointer moves) or a project VM running. Only the database decides that, so any control plane instance agrees.
 *
 * Deleting is the dangerous part, so it only ever reaches a row that is still a reserve: the row is first marked
 * deleted on condition that it is unclaimed, and a claim only takes a row that is not marked, so exactly one of the two
 * wins. The provider then deletes only the names it derives from that reserve's ID.
 */
export function make(db: Db, config: Config, provider: VmProvider, now = () => Date.now()) {
  const booting = new Set<string>()
  const pass = { again: false, running: undefined as Promise<void> | undefined }

  async function activeUsers() {
    const since = new Date(now() - config.vmReserveIdleMs)
    const live = and(eq(UserTable.is_disabled, false), isNull(UserTable.deleted_at))
    const [signedIn, working] = await Promise.all([
      db
        .selectDistinct({ id: AuthSessionTable.user_id })
        .from(AuthSessionTable)
        .innerJoin(UserTable, eq(UserTable.id, AuthSessionTable.user_id))
        .where(and(isNull(AuthSessionTable.ended_at), gt(AuthSessionTable.last_seen_at, since), live)),
      db
        .selectDistinct({ id: ProjectTable.user_id })
        .from(ProjectTable)
        .innerJoin(UserTable, eq(UserTable.id, ProjectTable.user_id))
        .where(
          and(
            isNull(ProjectTable.reserved_at),
            isNull(ProjectTable.deleted_at),
            inArray(ProjectTable.vm_state, ["creating", "running", "resuming", "pausing"]),
            live,
          ),
        ),
    ])
    return new Set([...signedIn, ...working].map((row) => row.id))
  }

  /** Whether a reserve is no use and should go: its user went idle, its boot failed or stuck, or its VM stopped. */
  function useless(row: Row, active: Set<string>) {
    if (row.deleted_at) return true
    if (booting.has(row.id)) return false
    if (!active.has(row.user_id)) return true
    const age = now() - row.created_at.getTime()
    if (row.vm_state === "failed") return age >= RETRY_MS
    if (row.vm_state === "creating") return age >= STUCK_MS
    // Paused, or stopping or starting: reconcile found its VM gone. A reserve is only worth keeping while it runs.
    return row.vm_state !== "running"
  }

  async function drop(row: Row) {
    if (!row.deleted_at) {
      const marked = await db
        .update(ProjectTable)
        .set({ deleted_at: new Date(now()) })
        .where(and(eq(ProjectTable.id, row.id), isNotNull(ProjectTable.reserved_at), isNull(ProjectTable.deleted_at)))
        .returning({ id: ProjectTable.id })
      // Claimed in the meantime: it is a project now, and stays.
      if (marked.length === 0) return
    }
    // Read again right before deleting: only a row that is still an unclaimed reserve marked for deletion qualifies.
    const current = (await db.select().from(ProjectTable).where(eq(ProjectTable.id, row.id)))[0]
    if (!current?.reserved_at || !current.deleted_at) return
    console.log(`deleting reserve ${row.id} of user ${row.user_id}`)
    await provider.destroy(row.id)
    await db
      .delete(ProjectTable)
      .where(
        and(eq(ProjectTable.id, row.id), isNotNull(ProjectTable.reserved_at), isNotNull(ProjectTable.deleted_at)),
      )
  }

  async function add(userID: string) {
    const id = crypto.randomUUID()
    const at = new Date(now())
    const project = (
      await db
        .insert(ProjectTable)
        .values({
          id,
          user_id: userID,
          // Never shown; unique, so it can't clash with a name the user picks.
          name: `.reserve-${id}`,
          slug: "",
          vm_state: "creating",
          project_token_hash: "",
          reserved_at: at,
          created_at: at,
          updated_at: at,
        })
        .returning()
    )[0]!
    console.log(`booting reserve ${id} for user ${userID}`)
    booting.add(id)
    // In the background: a boot takes up to `vmWakeTimeoutMs`, and the next pass counts it as held meanwhile.
    void provision(db, config, provider, project, now)
      .catch((error: unknown) => console.error(`booting reserve ${id} failed`, error))
      .finally(() => booting.delete(id))
  }

  async function run() {
    const rows = await db.select().from(ProjectTable).where(isNotNull(ProjectTable.reserved_at))
    const active = await activeUsers()
    const gone = rows.filter((row) => useless(row, active))
    await Promise.all(
      gone.map((row) => drop(row).catch((error: unknown) => console.error(`deleting reserve ${row.id} failed`, error))),
    )
    const kept = rows.filter((row) => !gone.includes(row))
    // A failed reserve is kept until RETRY_MS has passed, and holds its user's next one back until then.
    const waiting = new Set(kept.filter((row) => row.vm_state === "failed").map((row) => row.user_id))
    const held = Map.groupBy(
      kept.filter((row) => row.vm_state !== "failed"),
      (row) => row.user_id,
    )
    // One slot per reserve a user is short of, ranked by how many they already hold: under the cap, every active user
    // gets a first reserve before anyone gets a second.
    const missing = [...active]
      .filter((userID) => !waiting.has(userID))
      .flatMap((userID) => {
        const has = held.get(userID)?.length ?? 0
        return Array.from({ length: Math.max(0, config.vmReservesPerUser - has) }, (_, index) => ({
          userID,
          rank: has + index,
        }))
      })
      .toSorted((a, b) => a.rank - b.rank)
      .slice(0, Math.max(0, config.vmReservesMax - kept.length))
    for (const slot of missing)
      await add(slot.userID).catch((error: unknown) => console.error(`adding a reserve for ${slot.userID} failed`, error))
  }

  /**
   * Runs a pass now, or once more after the running one; passes never overlap. With reserves off it does nothing: a
   * local control plane, where they are off, must not delete the reserves of the deployed one sharing its database.
   */
  function refill() {
    if (config.vmReservesPerUser === 0) return Promise.resolve()
    pass.again = true
    if (pass.running) return pass.running
    pass.running = (async () => {
      while (pass.again) {
        pass.again = false
        await run().catch((error: unknown) => console.error("reserve pass failed", error))
      }
    })().finally(() => (pass.running = undefined))
    return pass.running
  }

  return {
    refill,

    /**
     * Turns one of the user's reserves into their new project: a running one first, else one booting here. The row
     * keeps its ID and VM. Undefined when they have none to claim; "exists" when the name is taken.
     */
    async claim(userID: string, input: { name: string; slug: string }): Promise<Row | "exists" | undefined> {
      const candidates = await db
        .select({ id: ProjectTable.id, vm_state: ProjectTable.vm_state })
        .from(ProjectTable)
        .where(
          and(
            eq(ProjectTable.user_id, userID),
            isNotNull(ProjectTable.reserved_at),
            isNull(ProjectTable.deleted_at),
            inArray(ProjectTable.vm_state, ["running", "creating"]),
          ),
        )
        .orderBy(asc(ProjectTable.created_at))
      const ordered = [
        ...candidates.filter((row) => row.vm_state === "running"),
        ...candidates.filter((row) => row.vm_state === "creating" && booting.has(row.id)),
      ]
      for (const candidate of ordered) {
        const at = new Date(now())
        const claimed = await db
          .update(ProjectTable)
          // Opening is activity: the sweeper must not pause what was just handed out.
          .set({ name: input.name, slug: input.slug, reserved_at: null, created_at: at, updated_at: at, last_activity_at: at })
          .where(
            and(
              eq(ProjectTable.id, candidate.id),
              eq(ProjectTable.user_id, userID),
              isNotNull(ProjectTable.reserved_at),
              isNull(ProjectTable.deleted_at),
            ),
          )
          .returning()
          .catch((error: unknown) => {
            if (uniqueViolation(error)) return "exists" as const
            throw error
          })
        if (claimed === "exists") return claimed
        const project = claimed[0]
        if (!project) continue
        console.log(`claimed reserve ${project.id} for user ${userID} (${project.vm_state})`)
        void refill()
        return project
      }
      return undefined
    },

    /** Passes every 30 s, and one now; none while reserves are off. Returns a stop function. */
    start() {
      if (config.vmReservesPerUser === 0) return () => {}
      void refill()
      const timer = setInterval(() => void refill(), PASS_MS)
      return () => clearInterval(timer)
    },
  }
}
