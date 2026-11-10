import { afterEach, describe, expect, test } from "bun:test"
import { writeFile } from "node:fs/promises"
import path from "node:path"
import { eq } from "drizzle-orm"
import { ProjectTable } from "../src/db/schema.js"
import { Sweeper } from "../src/vm/sweeper.js"
import { harness } from "./fixture/setup.js"

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((fn) => fn()))
})

async function setup() {
  const h = await harness()
  cleanup.push(() => h.provider.close())
  const sweeper = Sweeper.make({
    db: h.db,
    config: h.config,
    lifecycle: h.lifecycle,
    provider: h.provider,
    now: h.time.now,
  })
  const state = async (id: string) =>
    (await h.db.select().from(ProjectTable).where(eq(ProjectTable.id, id)))[0]!.vm_state
  const busy = (id: string, value: unknown) =>
    writeFile(path.join(h.root, id, "home", "busy.json"), JSON.stringify(value))
  return { ...h, sweeper, state, busy }
}

describe("Sweeper", () => {
  test("pauses after 2 minutes idle", async () => {
    const s = await setup()
    const id = await s.running()
    s.time.advance(s.config.vmIdleMs - 1000)
    await s.sweeper.sweep()
    expect(await s.state(id)).toBe("running")
    s.time.advance(1000)
    await s.sweeper.sweep()
    expect(await s.state(id)).toBe("paused")
    expect(await s.provider.list()).toEqual([])
  })

  test("recent activity keeps it running", async () => {
    const s = await setup()
    const id = await s.running()
    s.time.advance(s.config.vmIdleMs - 1000)
    await s.lifecycle.touch(id)
    s.time.advance(s.config.vmIdleMs - 1000)
    await s.sweeper.sweep()
    expect(await s.state(id)).toBe("running")
  })

  test("busy report keeps an idle VM running", async () => {
    const s = await setup()
    const id = await s.running()
    s.time.advance(s.config.vmIdleMs)
    s.lifecycle.recordBusy(id, { busy: true, reasons: ["sessions:1"] })
    await s.sweeper.sweep()
    expect(await s.state(id)).toBe("running")
  })

  test("stale report asks the VM", async () => {
    const s = await setup()
    const id = await s.running()
    s.lifecycle.recordBusy(id, { busy: false, reasons: [] })
    await s.busy(id, { busy: true, reasons: ["terminal:sleep"] })
    s.time.advance(s.config.vmIdleMs)
    await s.sweeper.sweep()
    expect(await s.state(id)).toBe("running")
    await s.busy(id, { busy: false, reasons: [] })
    s.time.advance(s.config.vmBusyFreshMs)
    await s.sweeper.sweep()
    expect(await s.state(id)).toBe("paused")
  })

  test("unreachable VM pauses only after the grace", async () => {
    const s = await setup()
    const id = await s.running()
    await s.busy(id, "error")
    s.time.advance(s.config.vmIdleMs)
    await s.sweeper.sweep()
    expect(await s.state(id)).toBe("running")
    s.time.advance(s.config.vmUnreachableGraceMs - 1000)
    await s.sweeper.sweep()
    expect(await s.state(id)).toBe("running")
    s.time.advance(1000)
    await s.sweeper.sweep()
    expect(await s.state(id)).toBe("paused")
  })

  test("deleted running VM is paused", async () => {
    const s = await setup()
    const id = await s.running()
    await s.db.update(ProjectTable).set({ deleted_at: new Date() }).where(eq(ProjectTable.id, id))
    await s.sweeper.sweep()
    expect(await s.state(id)).toBe("paused")
  })

  test("reconcile marks a vanished VM paused", async () => {
    const s = await setup()
    const id = await s.running()
    await s.provider.stop(id)
    await s.sweeper.reconcile()
    expect(await s.state(id)).toBe("paused")
  })

  test("reconcile stops a VM the database says is paused", async () => {
    const s = await setup()
    const id = await s.running()
    await s.db.update(ProjectTable).set({ vm_state: "paused" }).where(eq(ProjectTable.id, id))
    await s.sweeper.reconcile()
    expect(await s.provider.list()).toEqual([])
    expect(await s.state(id)).toBe("paused")
  })

  test("reconcile leaves a reserve being deleted to the reserve pool", async () => {
    const s = await setup()
    const id = await s.running()
    // The pool marks a reserve deleted, then deletes its VM; pausing it in between makes Northflank refuse the delete.
    await s.db
      .update(ProjectTable)
      .set({ reserved_at: new Date(), deleted_at: new Date() })
      .where(eq(ProjectTable.id, id))
    await s.sweeper.reconcile()
    expect(await s.provider.list()).toEqual([id])
    expect(await s.state(id)).toBe("running")
  })

  test("reconcile ignores unknown VMs", async () => {
    const s = await setup()
    const id = await s.running()
    await s.db.update(ProjectTable).set({ vm_id: "someone-else" }).where(eq(ProjectTable.id, id))
    await s.sweeper.reconcile()
    expect(await s.provider.list()).toEqual([id])
  })

  test("opening counts as activity, so the sweeper doesn't pause what was just opened", async () => {
    const s = await setup()
    const id = await s.running()
    s.time.advance(s.config.vmIdleMs * 2)
    await s.projects.open(s.a, "sid", id)
    await s.sweeper.sweep()
    expect(await s.state(id)).toBe("running")
  })

  test("a pause only goes ahead while the project is still idle", async () => {
    const s = await setup()
    const id = await s.running()
    s.time.advance(s.config.vmIdleMs)
    const idleSince = new Date(s.time.now() - s.config.vmIdleMs)
    await s.lifecycle.touch(id)
    expect(await s.lifecycle.pause(id, "idle", { idleSince })).toBe(false)
    expect(await s.state(id)).toBe("running")
  })
})
