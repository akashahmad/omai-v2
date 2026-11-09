import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { PlatformKeys } from "@opencode/core/plugin/provider/platform-keys"

const providers = [
  { id: "openai", models: [{ id: "gpt-5" }, { id: "gpt-4" }] },
  { id: "groq", integrationID: "groq", models: [{ id: "llama" }] },
  { id: "local", models: [{ id: "m" }] },
]
const shared = [
  { id: "openai", key: "sk-shared", models: ["gpt-5"] },
  { id: "groq", key: "gsk", models: ["llama"] },
]

describe("PlatformKeys", () => {
  test("is on only on a project VM", () => {
    expect(PlatformKeys.target({})).toBeUndefined()
    const env = { OMAI_PROJECT_ID: "p1", OMAI_PROJECT_TOKEN: "tok", OMAI_CONTROL_PLANE_URL: "http://cp:4101/" }
    expect(PlatformKeys.target(env)).toEqual({ url: "http://cp:4101", projectID: "p1", token: "tok" })
    expect(PlatformKeys.target({ ...env, OMAI_PROJECT_ID: "platform" })).toBeUndefined()
  })

  test("shared providers get their real key and only switched-on models; others are left alone", () => {
    expect(PlatformKeys.plan(providers, shared, new Set())).toEqual([
      { id: "openai", apiKey: "sk-shared", remove: ["gpt-4"] },
      { id: "groq", apiKey: "gsk", remove: [] },
    ])
  })

  test("a personal credential for the same provider wins; without it the shared key is back", () => {
    expect(PlatformKeys.plan(providers, shared, new Set(["openai"]))).toEqual([{ id: "groq", apiKey: "gsk", remove: [] }])
    expect(PlatformKeys.plan(providers, shared, new Set()).map((item) => item.id)).toEqual(["openai", "groq"])
  })

  test("a model switched off disappears", () => {
    const off = [{ id: "openai", key: "sk-shared", models: [] as string[] }]
    expect(PlatformKeys.plan(providers, off, new Set())).toEqual([{ id: "openai", apiKey: "sk-shared", remove: ["gpt-5", "gpt-4"] }])
  })

  test("the last list is kept on disk, owner-only, and read back when the control plane is down", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "omai-keys-"))
    const file = path.join(dir, "platform-keys.json")
    await PlatformKeys.save(file, shared)
    expect((await stat(file)).mode & 0o777).toBe(0o600)
    expect(await PlatformKeys.restore(file)).toEqual(shared)
    expect(await PlatformKeys.restore(path.join(dir, "missing.json"))).toEqual([])
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual(shared)
  })
})
