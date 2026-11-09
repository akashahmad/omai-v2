import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Integration } from "@opencode/core/integration"
import { PlatformKeys } from "@opencode/core/plugin/provider/platform-keys"

const providers = [
  { id: "openai", models: [{ id: "gpt-5" }, { id: "gpt-4" }] },
  { id: "groq", integrationID: "groq", models: [{ id: "llama" }] },
  { id: "local", models: [{ id: "m" }] },
]
const shared = [
  {
    id: "openai",
    integrationID: "openai",
    type: "oauth" as const,
    methodID: "chatgpt",
    metadata: { clientID: "c" },
    models: ["gpt-5"],
  },
  { id: "groq", integrationID: "groq", type: "key" as const, models: ["llama"] },
]

describe("PlatformKeys", () => {
  test("is on only on a project VM", () => {
    expect(PlatformKeys.target({})).toBeUndefined()
    const env = { OMAI_PROJECT_ID: "p1", OMAI_PROJECT_TOKEN: "tok", OMAI_CONTROL_PLANE_URL: "http://cp:4101/" }
    expect(PlatformKeys.target(env)).toEqual({ url: "http://cp:4101", projectID: "p1", token: "tok" })
    expect(PlatformKeys.target({ ...env, OMAI_PROJECT_ID: "platform" })).toBeUndefined()
  })

  test("shared providers keep only switched-on models; others are left alone", () => {
    expect(PlatformKeys.plan(providers, shared, new Set())).toEqual([
      { id: "openai", remove: ["gpt-4"] },
      { id: "groq", remove: [] },
    ])
  })

  test("a personal credential for the same provider wins; without it the shared one is back", () => {
    expect(PlatformKeys.plan(providers, shared, new Set(["openai"]))).toEqual([{ id: "groq", remove: [] }])
    expect(PlatformKeys.plan(providers, shared, new Set()).map((item) => item.id)).toEqual(["openai", "groq"])
  })

  test("a model switched off disappears", () => {
    const off = [{ ...shared[0]!, models: [] as string[] }]
    expect(PlatformKeys.plan(providers, off, new Set())).toEqual([{ id: "openai", remove: ["gpt-5", "gpt-4"] }])
  })

  test("each shared integration the user hasn't connected gets a stand-in credential, never the secret", () => {
    expect(PlatformKeys.standIns(shared, new Set(["groq"]))).toEqual([
      {
        id: "cred_shared_openai",
        integrationID: "openai",
        label: "Shared",
        value: {
          type: "oauth",
          methodID: Integration.MethodID.make("chatgpt"),
          access: "omai-gw.s~openai",
          refresh: "omai-gw.s~openai",
          expires: 253_402_300_799_000,
          metadata: { clientID: "c" },
        },
      },
    ])
    expect(PlatformKeys.standIns(shared, new Set(["openai"]))).toEqual([
      { id: "cred_shared_groq", integrationID: "groq", label: "Shared", value: { type: "key", key: "omai-gw.s~groq" } },
    ])
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
