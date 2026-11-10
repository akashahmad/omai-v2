import { afterEach, describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import path from "node:path"
import { and, eq, isNotNull } from "drizzle-orm"
import { AuthSessionTable, ProjectTable } from "../src/db/schema.js"
import type { VmLabel, VmProvider } from "../src/vm/provider.js"
import { harness, until } from "./fixture/setup.js"

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((fn) => fn()))
})

async function setup(env: Record<string, string> = {}) {
  // Every label a VM was created with or given later, by project ID.
  const labels = new Map<string, VmLabel[]>()
  const record = (projectID: string, label: VmLabel) => labels.set(projectID, [...(labels.get(projectID) ?? []), label])
  const s = await harness(
    { OMAI_VM_RESERVES_PER_USER: "2", OMAI_VM_RESERVE_IDLE_MS: "600000", ...env },
    (provider): VmProvider => ({
      ...provider,
      create: (spec) => {
        if (spec.label) record(spec.projectID, spec.label)
        return provider.create(spec)
      },
      label: (vmID, projectID, label) => {
        record(projectID, label)
        return provider.label(vmID, projectID, label)
      },
    }),
  )
  cleanup.push(() => s.provider.close())
  const signIn = (userID: string) =>
    s.db.insert(AuthSessionTable).values({
      id: crypto.randomUUID(),
      user_id: userID,
      refresh_hash: crypto.randomUUID(),
      last_seen_at: new Date(s.time.now()),
    })
  const reserves = (userID?: string) =>
    s.db
      .select()
      .from(ProjectTable)
      .where(and(isNotNull(ProjectTable.reserved_at), userID ? eq(ProjectTable.user_id, userID) : undefined))
  /** Runs passes until the user holds `count` running reserves. */
  const ready = (userID: string, count: number) =>
    until(
      async () => {
        await s.projects.reserves.refill()
        return reserves(userID)
      },
      (rows) => rows.filter((row) => row.vm_state === "running").length === count,
    )
  const vmDir = (projectID: string) => path.join(s.root, projectID)
  return { ...s, signIn, reserves, ready, vmDir, labels }
}

describe("reserve VMs", () => {
  test("an active user gets their reserves booted, and never sees them", async () => {
    const s = await setup()
    await s.signIn(s.a)
    const rows = await s.ready(s.a, 2)
    expect(await s.projects.list(s.a)).toEqual([])
    for (const row of rows) {
      expect(await s.projects.get(s.a, row.id)).toBeUndefined()
      expect(await s.projects.open(s.a, "sid", row.id)).toBeUndefined()
      expect(await s.projects.host(row.id)).toBeUndefined()
      // No folder name until claimed, so the VM's project endpoints stay closed.
      expect(await s.projects.vm(row.id)).toEqual({})
    }
    // A user who isn't active gets none.
    expect(await s.reserves(s.b)).toEqual([])
  })

  test("creating a project claims a running reserve, which opens at once and is replaced", async () => {
    const s = await setup()
    await s.signIn(s.a)
    const before = await s.ready(s.a, 2)
    const created = await s.projects.create(s.a, "My Shop")
    if (typeof created === "string") throw new Error(created)
    expect(before.map((row) => row.id)).toContain(created.id)
    expect(created).toMatchObject({ name: "My Shop", slug: "my-shop", vmState: "running" })
    expect(await s.projects.vm(created.id)).toEqual({ slug: "my-shop" })
    const opened = await s.projects.open(s.a, "sid", created.id)
    expect(opened).toMatchObject({ directory: expect.stringMatching(/\/my-shop$/) })
    expect((await s.projects.list(s.a)).map((project) => project.id)).toEqual([created.id])
    const after = await s.ready(s.a, 2)
    expect(after.map((row) => row.id)).not.toContain(created.id)
  })

  test("a reserve's VM is labelled as one, then with its project and user once claimed or renamed", async () => {
    const s = await setup()
    await s.signIn(s.a)
    await s.ready(s.a, 2)
    const created = await s.projects.create(s.a, "My Shop")
    if (typeof created === "string") throw new Error(created)
    expect(s.labels.get(created.id)?.[0]).toEqual({ type: "reserve", userName: "a" })
    await until(
      async () => s.labels.get(created.id)?.at(-1),
      (label) => label?.type === "vm",
    )
    expect(s.labels.get(created.id)?.at(-1)).toEqual({ type: "vm", projectName: "My Shop", userName: "a" })
    await s.projects.rename(s.a, created.id, "Big Shop")
    await until(
      async () => s.labels.get(created.id)?.at(-1),
      (label) => label?.projectName === "Big Shop",
    )
    // A project made without a reserve is labelled from the start.
    const plain = await s.projects.create(s.b, "Plain")
    if (typeof plain === "string") throw new Error(plain)
    await until(
      async () => s.labels.get(plain.id),
      (labels) => labels !== undefined,
    )
    expect(s.labels.get(plain.id)).toEqual([{ type: "vm", projectName: "Plain", userName: "b" }])
  })

  test("a taken name is refused without using up a reserve", async () => {
    const s = await setup()
    await s.signIn(s.a)
    await s.ready(s.a, 2)
    expect(typeof (await s.projects.create(s.a, "Shop"))).toBe("object")
    await s.ready(s.a, 2)
    expect(await s.projects.create(s.a, "shop")).toBe("exists")
    expect((await s.reserves(s.a)).filter((row) => !row.deleted_at)).toHaveLength(2)
  })

  test("idle users lose their reserves, and no project VM is touched", async () => {
    const s = await setup()
    await s.signIn(s.a)
    const reserved = await s.ready(s.a, 2)
    // A claimed reserve and a project made the usual way (user b has no reserves) must both survive.
    const claimed = await s.projects.create(s.a, "Claimed")
    if (typeof claimed === "string") throw new Error(claimed)
    const plain = await s.projects.create(s.b, "Plain")
    if (typeof plain === "string") throw new Error(plain)
    await until(
      () => s.projects.get(s.b, plain.id),
      (project) => project?.vmState === "running",
    )
    const spares = (await s.ready(s.a, 2)).map((row) => row.id)
    await s.lifecycle.pause(claimed.id, "test")
    await s.lifecycle.pause(plain.id, "test")
    s.time.advance(600_001)

    await until(
      async () => {
        await s.projects.reserves.refill()
        return s.reserves()
      },
      (rows) => rows.length === 0,
    )
    const running = await s.provider.list()
    for (const id of spares) {
      expect(running).not.toContain(id)
      expect(existsSync(s.vmDir(id))).toBe(false)
    }
    expect(reserved.map((row) => row.id)).toContain(claimed.id)
    for (const project of [
      { user: s.a, id: claimed.id },
      { user: s.b, id: plain.id },
    ]) {
      expect(await s.projects.get(project.user, project.id)).toMatchObject({ vmState: "paused" })
      expect(existsSync(s.vmDir(project.id))).toBe(true)
    }
  })

  test("a running project keeps its user active", async () => {
    const s = await setup()
    await s.signIn(s.a)
    await s.ready(s.a, 2)
    expect(typeof (await s.projects.create(s.a, "Working"))).toBe("object")
    s.time.advance(600_001)
    await s.projects.reserves.refill()
    // Their sign-in went quiet, but a project VM still runs: the spare and its replacement stay.
    expect((await s.reserves(s.a)).filter((row) => !row.deleted_at).length).toBeGreaterThan(0)
  })

  test("a reserve marked for deletion is never claimed", async () => {
    const s = await setup()
    await s.signIn(s.a)
    const rows = await s.ready(s.a, 2)
    await s.db
      .update(ProjectTable)
      .set({ deleted_at: new Date(s.time.now()) })
      .where(isNotNull(ProjectTable.reserved_at))
    const created = await s.projects.create(s.a, "Fresh")
    if (typeof created === "string") throw new Error(created)
    expect(rows.map((row) => row.id)).not.toContain(created.id)
    expect(created.vmState).toBe("creating")
  })

  test("at most the global cap, with each active user's first reserve before anyone's second", async () => {
    const s = await setup({ OMAI_VM_RESERVES_MAX: "2" })
    await s.signIn(s.a)
    await s.signIn(s.b)
    await until(
      async () => {
        await s.projects.reserves.refill()
        return s.reserves()
      },
      (rows) => rows.filter((row) => row.vm_state === "running").length === 2,
    )
    await s.projects.reserves.refill()
    const rows = await s.reserves()
    expect(rows).toHaveLength(2)
    expect(new Set(rows.map((row) => row.user_id))).toEqual(new Set([s.a, s.b]))
  })

  test("with reserves off, nothing is booted and existing reserves are left alone", async () => {
    const s = await setup({ OMAI_VM_RESERVES_PER_USER: "0" })
    await s.signIn(s.a)
    await s.db.insert(ProjectTable).values({
      id: crypto.randomUUID(),
      user_id: s.b,
      name: ".reserve-left",
      slug: "",
      vm_state: "running",
      project_token_hash: "",
      reserved_at: new Date(s.time.now()),
    })
    s.time.advance(600_001)
    await s.projects.reserves.refill()
    expect(s.projects.reserves.start()).toBeFunction()
    const rows = await s.reserves()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.deleted_at).toBeNull()
  })
})
