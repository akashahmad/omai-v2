import { and, eq, isNull, lte, or } from "drizzle-orm"
import type { Config } from "../config.js"
import type { Db } from "../db/database.js"
import { ProjectTable, type VmState } from "../db/schema.js"
import type { VmAddress, VmProvider } from "./provider.js"
import { waitReady } from "./provision.js"

export * as Lifecycle from "./lifecycle.js"

export type BusyReport = { busy: boolean; reasons: string[] }

export type Lifecycle = ReturnType<typeof make>

// Presence and router traffic arrive often; the clock only needs this resolution against a 2-minute limit.
const TOUCH_EVERY_MS = 15_000

/**
 * Pauses and resumes project VMs. Every transition of one project runs after the previous one finished (one control
 * plane instance), and each database write is conditional on the state it expects, so a pause and a resume never race.
 */
export function make(db: Db, config: Config, provider: VmProvider, now = () => Date.now()) {
  const chains = new Map<string, Promise<unknown>>()
  const touched = new Map<string, number>()
  const busy = new Map<string, BusyReport & { at: number }>()

  function serial<T>(projectID: string, run: () => Promise<T>) {
    const next = (chains.get(projectID) ?? Promise.resolve()).then(run, run)
    const settled = next.then(
      () => undefined,
      () => undefined,
    )
    chains.set(projectID, settled)
    void settled.then(() => {
      if (chains.get(projectID) === settled) chains.delete(projectID)
    })
    return next
  }

  async function read(projectID: string) {
    return (await db.select().from(ProjectTable).where(eq(ProjectTable.id, projectID)))[0]
  }

  async function move(projectID: string, from: VmState, set: Partial<typeof ProjectTable.$inferInsert>) {
    const updated = await db
      .update(ProjectTable)
      .set(set)
      .where(and(eq(ProjectTable.id, projectID), eq(ProjectTable.vm_state, from)))
      .returning({ id: ProjectTable.id })
    return updated.length > 0
  }

  return {
    /** Starts the project's VM if it is paused and waits until its server answers. */
    resume(projectID: string): Promise<VmAddress | "not-ready" | "deleted"> {
      return serial(projectID, async () => {
        const project = await read(projectID)
        if (!project || project.deleted_at) return "deleted"
        if (project.vm_state === "creating" || project.vm_state === "failed" || !project.vm_id) return "not-ready"
        const vmID = project.vm_id
        const start = async () => {
          const address = await provider.ensureRunning(vmID)
          await waitReady(config, { userID: project.user_id, projectID, host: address.host })
          return address
        }
        if (project.vm_state === "running") {
          // Cheap when it runs; starts it again when the process went away before reconcile noticed.
          const address = await start()
          // Opening is activity: the sweeper must not pause what was just handed out.
          await move(projectID, "running", {
            vm_host: address.host,
            vm_home: address.home,
            vm_preview: address.preview ?? null,
            last_activity_at: new Date(now()),
          })
          touched.set(projectID, now())
          return address
        }
        await move(projectID, project.vm_state, { vm_state: "resuming" })
        const address = await start().catch(async (error: unknown) => {
          await move(projectID, "resuming", { vm_state: "paused" })
          throw error
        })
        await move(projectID, "resuming", {
          vm_state: "running",
          vm_host: address.host,
          vm_home: address.home,
          vm_preview: address.preview ?? null,
          last_activity_at: new Date(now()),
        })
        touched.set(projectID, now())
        console.log(`resumed ${projectID}`)
        return address
      })
    },

    /**
     * Stops a running VM, keeping its volume. With `idleSince`, only while its last activity is still no later than that,
     * so activity that arrived after the sweeper looked keeps it running. False when it wasn't paused.
     */
    pause(projectID: string, reason: string, options: { idleSince?: Date } = {}): Promise<boolean> {
      return serial(projectID, async () => {
        const project = await read(projectID)
        if (!project?.vm_id) return false
        const vmID = project.vm_id
        const idle = options.idleSince
          ? or(isNull(ProjectTable.last_activity_at), lte(ProjectTable.last_activity_at, options.idleSince))
          : undefined
        const started = await db
          .update(ProjectTable)
          .set({ vm_state: "pausing" })
          .where(and(eq(ProjectTable.id, projectID), eq(ProjectTable.vm_state, "running"), idle))
          .returning({ id: ProjectTable.id })
        if (started.length === 0) return false
        console.log(`pausing ${projectID}: ${reason}`)
        await provider.stop(vmID).catch(async (error: unknown) => {
          await move(projectID, "pausing", { vm_state: "running" })
          throw error
        })
        await move(projectID, "pausing", { vm_state: "paused" })
        busy.delete(projectID)
        return true
      })
    },

    /**
     * Brings one project's state in line with whether its VM really runs: a paused or deleted project's running VM is
     * stopped, and a VM recorded as running that isn't is marked paused (e.g. after the control plane restarted).
     */
    reconcile(projectID: string) {
      return serial(projectID, async () => {
        const project = await read(projectID)
        if (!project?.vm_id) return
        const vmID = project.vm_id
        const running = (await provider.list()).includes(vmID)
        // A reserve marked deleted is the reserve pool's to delete: pausing it first makes Northflank refuse the delete.
        const deleted = project.deleted_at && !project.reserved_at
        if (running && (project.vm_state === "paused" || (deleted && project.vm_state === "running"))) {
          console.log(`reconcile: stopping ${projectID} (${project.deleted_at ? "deleted" : "paused"})`)
          await provider.stop(vmID)
          await move(projectID, project.vm_state, { vm_state: "paused" })
          return
        }
        if (!running && ["running", "pausing", "resuming"].includes(project.vm_state)) {
          console.log(`reconcile: ${projectID} is not running; marking it paused`)
          await move(projectID, project.vm_state, { vm_state: "paused" })
        }
      })
    },

    /** Records genuine activity. False for a project that doesn't exist or is deleted. */
    async touch(projectID: string) {
      const last = touched.get(projectID)
      if (last !== undefined && now() - last < TOUCH_EVERY_MS) return true
      const updated = await db
        .update(ProjectTable)
        .set({ last_activity_at: new Date(now()) })
        .where(and(eq(ProjectTable.id, projectID), isNull(ProjectTable.deleted_at)))
        .returning({ id: ProjectTable.id })
      if (updated.length === 0) return false
      touched.set(projectID, now())
      return true
    },

    /** Drops what is kept in memory for a project that was deleted, so its activity stops counting at once. */
    forget(projectID: string) {
      touched.delete(projectID)
      busy.delete(projectID)
    },

    recordBusy(projectID: string, report: BusyReport) {
      busy.set(projectID, { busy: report.busy, reasons: report.reasons, at: now() })
    },

    /** The VM's last pushed report, or undefined when none arrived within `vmBusyFreshMs`. */
    latestBusy(projectID: string): BusyReport | undefined {
      const hit = busy.get(projectID)
      if (!hit || now() - hit.at >= config.vmBusyFreshMs) return undefined
      return { busy: hit.busy, reasons: hit.reasons }
    },
  }
}
