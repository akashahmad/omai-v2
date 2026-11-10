import { and, eq, isNotNull, isNull } from "drizzle-orm"
import { Schema } from "effect"
import type { Config } from "../config.js"
import type { Db } from "../db/database.js"
import { ProjectTable } from "../db/schema.js"
import type { BusyReport, Lifecycle } from "./lifecycle.js"
import type { VmProvider } from "./provider.js"
import { vmToken } from "./provision.js"

export * as Sweeper from "./sweeper.js"

const decodeReport = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ busy: Schema.Boolean, reasons: Schema.Array(Schema.String) })),
)

/**
 * Pauses idle VMs: running, no activity for `vmIdleMs`, and not busy by their latest report (or by asking them when
 * the report is stale). A VM that can't be asked pauses once it has been unreachable for `vmUnreachableGraceMs`.
 */
export function make(deps: { db: Db; config: Config; lifecycle: Lifecycle; provider: VmProvider; now?: () => number }) {
  const now = deps.now ?? (() => Date.now())
  const config = deps.config
  const unreachableSince = new Map<string, number>()

  async function ask(project: { id: string; user_id: string; vm_host: string | null }) {
    if (!project.vm_host) return undefined
    const token = vmToken(config, {
      userID: project.user_id,
      projectID: project.id,
      sessionID: "control-plane",
      host: project.vm_host,
    })
    const text = await fetch(`${project.vm_host}/api/experimental/project-vm/busy`, {
      headers: { authorization: `Basic ${Buffer.from(`omai:${token}`).toString("base64")}` },
      signal: AbortSignal.timeout(2000),
    }).then(
      (res) => (res.ok ? res.text() : undefined),
      () => undefined,
    )
    if (text === undefined) return undefined
    const report = decodeReport(text)
    return report._tag === "Some" ? { busy: report.value.busy, reasons: [...report.value.reasons] } : undefined
  }

  async function check(project: typeof ProjectTable.$inferSelect) {
    if (project.deleted_at) return deps.lifecycle.pause(project.id, "deleted")
    const last = project.last_activity_at?.getTime() ?? 0
    const idleSince = new Date(now() - config.vmIdleMs)
    if (last > idleSince.getTime()) {
      unreachableSince.delete(project.id)
      return
    }
    const report: BusyReport | undefined = deps.lifecycle.latestBusy(project.id) ?? (await ask(project))
    if (!report) {
      const since = unreachableSince.get(project.id) ?? now()
      unreachableSince.set(project.id, since)
      if (now() - since >= config.vmUnreachableGraceMs) {
        unreachableSince.delete(project.id)
        return deps.lifecycle.pause(project.id, "unreachable", { idleSince })
      }
      return
    }
    unreachableSince.delete(project.id)
    deps.lifecycle.recordBusy(project.id, report)
    if (report.busy) return
    return deps.lifecycle.pause(project.id, "idle", { idleSince })
  }

  async function sweep() {
    // A reserve waits for its user unused on purpose; the reserve pool decides when it goes.
    const running = await deps.db
      .select()
      .from(ProjectTable)
      .where(and(eq(ProjectTable.vm_state, "running"), isNull(ProjectTable.reserved_at)))
    await Promise.all(
      running.map((project) =>
        check(project).catch((error: unknown) => console.error(`sweeping ${project.id} failed`, error)),
      ),
    )
  }

  async function reconcile() {
    const running = new Set(await deps.provider.list())
    const rows = await deps.db
      .select({
        id: ProjectTable.id,
        vm_id: ProjectTable.vm_id,
        vm_state: ProjectTable.vm_state,
        deleted_at: ProjectTable.deleted_at,
      })
      .from(ProjectTable)
      .where(isNotNull(ProjectTable.vm_id))
    const known = new Set(rows.map((row) => row.vm_id))
    for (const vmID of running)
      if (!known.has(vmID)) console.warn(`reconcile: VM ${vmID} is not ours; leaving it alone`)
    const off = rows.filter((row) => {
      const up = running.has(row.vm_id!)
      if (up) return row.vm_state === "paused" || (!!row.deleted_at && row.vm_state === "running")
      return row.vm_state === "running" || row.vm_state === "pausing" || row.vm_state === "resuming"
    })
    await Promise.all(
      off.map((row) =>
        deps.lifecycle
          .reconcile(row.id)
          .catch((error: unknown) => console.error(`reconciling ${row.id} failed`, error)),
      ),
    )
  }

  return {
    sweep,
    reconcile,
    /** Reconciles once, then sweeps and reconciles on their intervals. Returns a stop function. */
    start() {
      const busy = { sweep: false, reconcile: false }
      const guarded = (name: keyof typeof busy, run: () => Promise<void>) => () => {
        if (busy[name]) return
        busy[name] = true
        void run()
          .catch((error: unknown) => console.error(`${name} failed`, error))
          .finally(() => (busy[name] = false))
      }
      const doReconcile = guarded("reconcile", reconcile)
      const doSweep = guarded("sweep", sweep)
      doReconcile()
      const timers = [setInterval(doSweep, config.vmSweepMs), setInterval(doReconcile, config.vmReconcileMs)]
      return () => timers.forEach(clearInterval)
    },
  }
}
