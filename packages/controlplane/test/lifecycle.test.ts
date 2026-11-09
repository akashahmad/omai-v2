import { afterEach, describe, expect, test } from "bun:test"
import { eq } from "drizzle-orm"
import { ProjectTable } from "../src/db/schema.js"
import { harness, until } from "./fixture/setup.js"

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((fn) => fn()))
})

async function setup(wrap?: Parameters<typeof harness>[1], env: Record<string, string> = {}) {
  const h = await harness(env, wrap)
  cleanup.push(() => h.provider.close())
  const state = async (id: string) => (await h.db.select().from(ProjectTable).where(eq(ProjectTable.id, id)))[0]!
  const answers = (host: string) =>
    fetch(`${host}/api/info`, { signal: AbortSignal.timeout(1000) }).then(
      (res) => res.ok,
      () => false,
    )
  return { ...h, state, answers }
}

describe("Lifecycle", () => {
  test("pause then resume returns the same host and ends running", async () => {
    const s = await setup()
    const id = await s.running()
    const before = await s.state(id)
    expect(await s.lifecycle.pause(id, "test")).toBe(true)
    expect((await s.state(id)).vm_state).toBe("paused")
    expect(await s.provider.list()).toEqual([])
    const address = await s.lifecycle.resume(id)
    if (typeof address === "string") throw new Error(address)
    expect(address.host).toBe(before.vm_host!)
    expect((await s.state(id)).vm_state).toBe("running")
    expect(await s.answers(address.host)).toBe(true)
  })

  // Northflank publishes the preview port under an address known only once the VM exists.
  test("the preview's public origin is recorded on create and on resume", async () => {
    const preview = { value: "https://first.code.run" }
    const s = await setup((provider) => ({
      ...provider,
      create: async (spec) => ({ ...(await provider.create(spec)), preview: preview.value }),
      ensureRunning: async (vmID) => ({ ...(await provider.ensureRunning(vmID)), preview: preview.value }),
      stop: (vmID) => provider.stop(vmID),
      list: () => provider.list(),
    }))
    const id = await s.running()
    expect((await s.state(id)).vm_preview).toBe("https://first.code.run")
    await s.lifecycle.pause(id, "test")
    preview.value = "https://second.code.run"
    await s.lifecycle.resume(id)
    expect((await s.state(id)).vm_preview).toBe("https://second.code.run")
  })

  // A real VM bills while it runs: one whose server never answers must not be left running, and its row must know it.
  test("a VM whose server never answers is recorded, stopped and marked failed", async () => {
    const stopped: string[] = []
    const s = await setup(
      (provider) => ({
        ...provider,
        create: async (spec) => ({ ...(await provider.create(spec)), host: "http://127.0.0.1:9", preview: "https://p.code.run" }),
        ensureRunning: (vmID) => provider.ensureRunning(vmID),
        stop: async (vmID) => {
          stopped.push(vmID)
          await provider.stop(vmID)
        },
        list: () => provider.list(),
      }),
      { OMAI_VM_WAKE_TIMEOUT_MS: "300" },
    )
    const created = await s.projects.create(s.a, "Never")
    if (typeof created === "string") throw new Error(created)
    const row = await until(
      () => s.state(created.id),
      (value) => value.vm_state === "failed",
    )
    expect(row.vm_id).toBe(created.id)
    expect(row.vm_preview).toBe("https://p.code.run")
    expect(stopped).toEqual([created.id])
    expect(await s.provider.list()).toEqual([])
  })

  test("resume during pause waits and ends running", async () => {
    const s = await setup()
    const id = await s.running()
    const pausing = s.lifecycle.pause(id, "test")
    const resumed = await s.lifecycle.resume(id)
    expect(await pausing).toBe(true)
    if (typeof resumed === "string") throw new Error(resumed)
    expect((await s.state(id)).vm_state).toBe("running")
    expect(await s.answers(resumed.host)).toBe(true)
  })

  test("two resumes start one process", async () => {
    const s = await setup()
    const id = await s.running()
    await s.lifecycle.pause(id, "test")
    await Promise.all([s.lifecycle.resume(id), s.lifecycle.resume(id)])
    expect(await s.provider.list()).toEqual([id])
    expect(await s.lifecycle.pause(id, "again")).toBe(true)
    expect(await s.lifecycle.pause(id, "twice")).toBe(false)
  })

  test("resume refuses deleted and not-ready", async () => {
    const s = await setup()
    const id = await s.running()
    await s.db.update(ProjectTable).set({ vm_state: "failed" }).where(eq(ProjectTable.id, id))
    expect(await s.lifecycle.resume(id)).toBe("not-ready")
    await s.db.update(ProjectTable).set({ vm_state: "paused", deleted_at: new Date() }).where(eq(ProjectTable.id, id))
    expect(await s.lifecycle.resume(id)).toBe("deleted")
    expect(await s.lifecycle.resume("unknown")).toBe("deleted")
  })

  test("touch writes at most every 15 s", async () => {
    const s = await setup()
    const id = await s.running()
    const at = async () => (await s.state(id)).last_activity_at?.getTime()
    s.time.advance(60_000)
    expect(await s.lifecycle.touch(id)).toBe(true)
    const first = await at()
    expect(first).toBe(s.time.now())
    s.time.advance(5_000)
    await s.lifecycle.touch(id)
    expect(await at()).toBe(first)
    s.time.advance(11_000)
    await s.lifecycle.touch(id)
    expect(await at()).toBe(s.time.now())
    expect(await s.lifecycle.touch("unknown")).toBe(false)
  })

  test("busy report goes stale", async () => {
    const s = await setup()
    const id = await s.running()
    s.lifecycle.recordBusy(id, { busy: true, reasons: ["sessions:1"] })
    expect(s.lifecycle.latestBusy(id)).toEqual({ busy: true, reasons: ["sessions:1"] })
    s.time.advance(s.config.vmBusyFreshMs)
    expect(s.lifecycle.latestBusy(id)).toBeUndefined()
  })

  test("soft delete pauses the VM", async () => {
    const s = await setup()
    const id = await s.running()
    expect(await s.projects.remove(s.a, id)).toBe(true)
    await until(
      () => s.provider.list(),
      (list) => list.length === 0,
    )
    await until(
      async () => (await s.state(id)).vm_state,
      (state) => state === "paused",
    )
  })

  test("open resumes a paused project", async () => {
    const s = await setup()
    const id = await s.running()
    await s.lifecycle.pause(id, "test")
    const opened = await s.projects.open(s.a, "sid", id)
    if (!opened || opened === "not-ready") throw new Error("expected open")
    expect((await s.state(id)).vm_state).toBe("running")
    expect(await s.provider.list()).toEqual([id])
  })

  test("provisioning starts the activity clock", async () => {
    const s = await setup()
    const id = await s.running()
    expect((await s.state(id)).last_activity_at?.getTime()).toBe(s.time.now())
  })
})
