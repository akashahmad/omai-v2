import { describe, expect, test } from "bun:test"
import { ProjectVmCredentials } from "@opencode/core/project-vm/credentials"

type Local = { id: string; integrationID: string; label: string; value: unknown }
type Remote = { id: string; integrationID: string; label: string; value: unknown; updatedAt: number; deleted: boolean }

function fakes(remote: Remote[] = [], local: Local[] = []) {
  const state = { local: [...local], remote: [...remote], puts: [] as string[], deletes: [] as string[], time: 100 }
  const store = {
    all: async () => state.local.map((item) => ({ ...item })),
    // Like the real store: a value it can't decode is not applied.
    create: async (item: Local) => {
      if (!applicable(item.value)) return false
      state.local.push({ ...item })
      return true
    },
    update: async (id: string, item: { label: string; value: unknown }) => {
      if (!applicable(item.value)) return false
      state.local = state.local.map((entry) => (entry.id === id ? { ...entry, ...item } : entry))
      return true
    },
    remove: async (id: string) => {
      state.local = state.local.filter((entry) => entry.id !== id)
    },
  }
  const server = {
    pull: async () => state.remote.map((item) => ({ ...item })),
    put: async (item: Local & { updatedAt: number }) => {
      state.puts.push(item.id)
      state.remote = [...state.remote.filter((entry) => entry.id !== item.id), { ...item, deleted: false }]
      return "ok" as const
    },
    remove: async (id: string, at: number) => {
      state.deletes.push(id)
      state.remote = state.remote.map((entry) =>
        entry.id === id ? { ...entry, deleted: true, value: null, updatedAt: at } : entry,
      )
      return "ok" as const
    },
  }
  const sync = ProjectVmCredentials.create({ store, server, now: () => state.time++ })
  return { state, sync }
}

const key = (value: string) => ({ type: "key", key: value })
const applicable = (value: unknown) => typeof value === "object" && value !== null && "type" in value

describe("ProjectVmCredentials", () => {
  test("pulled credentials appear locally and are not pushed back", async () => {
    const f = fakes([
      { id: "c1", integrationID: "openai", label: "Mine", value: key("sk"), updatedAt: 5, deleted: false },
    ])
    await f.sync.pull()
    expect(f.state.local).toEqual([{ id: "c1", integrationID: "openai", label: "Mine", value: key("sk") }])
    await f.sync.push()
    expect(f.state.puts).toEqual([])
  })

  test("a local add is pushed once; a local change is pushed again", async () => {
    const f = fakes()
    await f.sync.pull()
    f.state.local.push({ id: "c2", integrationID: "anthropic", label: "A", value: key("ak") })
    await f.sync.push()
    await f.sync.push()
    expect(f.state.puts).toEqual(["c2"])
    f.state.local[0]!.value = key("ak-2")
    await f.sync.push()
    expect(f.state.puts).toEqual(["c2", "c2"])
  })

  test("a local remove is pushed as a delete", async () => {
    const f = fakes([
      { id: "c1", integrationID: "openai", label: "Mine", value: key("sk"), updatedAt: 5, deleted: false },
    ])
    await f.sync.pull()
    f.state.local = []
    await f.sync.push()
    expect(f.state.deletes).toEqual(["c1"])
    await f.sync.pull()
    expect(f.state.local).toEqual([])
  })

  test("a tombstone or a newer value from another VM is applied", async () => {
    const f = fakes([
      { id: "c1", integrationID: "openai", label: "Mine", value: key("sk"), updatedAt: 5, deleted: false },
    ])
    await f.sync.pull()
    f.state.remote = [
      { id: "c1", integrationID: "openai", label: "Renamed", value: key("sk-2"), updatedAt: 9, deleted: false },
    ]
    await f.sync.pull()
    expect(f.state.local[0]).toMatchObject({ label: "Renamed", value: key("sk-2") })
    f.state.remote = [{ id: "c1", integrationID: "openai", label: "", value: null, updatedAt: 12, deleted: true }]
    await f.sync.pull()
    expect(f.state.local).toEqual([])
    await f.sync.push()
    expect(f.state.puts).toEqual([])
    expect(f.state.deletes).toEqual([])
  })

  test("an item that can't be applied is not recorded, so it is never deleted or rolled back", async () => {
    const f = fakes([{ id: "c1", integrationID: "openai", label: "Mine", value: null, updatedAt: 5, deleted: false }])
    await f.sync.pull()
    await f.sync.push()
    expect(f.state.local).toEqual([])
    expect(f.state.deletes).toEqual([])
    expect(f.state.puts).toEqual([])
  })

  test("a local delete not yet pushed is not undone by a pull", async () => {
    const f = fakes([
      { id: "c1", integrationID: "openai", label: "Mine", value: key("sk"), updatedAt: 5, deleted: false },
    ])
    await f.sync.pull()
    f.state.local = []
    await f.sync.pull()
    expect(f.state.local).toEqual([])
    await f.sync.push()
    expect(f.state.deletes).toEqual(["c1"])
  })

  test("only API keys sync: sign-ins stay on the project they were made on", async () => {
    const oauth = { type: "oauth", access: "a", refresh: "r", expires: 1 }
    const f = fakes(
      [{ id: "c1", integrationID: "openai", label: "ChatGPT", value: oauth, updatedAt: 5, deleted: false }],
      [{ id: "c2", integrationID: "github-copilot", label: "Copilot", value: oauth }],
    )
    await f.sync.pull()
    await f.sync.push()
    expect(f.state.local.map((item) => item.id)).toEqual(["c2"])
    expect(f.state.puts).toEqual([])
    expect(f.state.deletes).toEqual([])
  })
})
