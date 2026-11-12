import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Credential } from "@opencode/core/credential"
import { Integration } from "@opencode/core/integration"
import { ProjectVmManaged } from "@opencode/core/project-vm/managed"
import { PlatformKeys } from "@opencode/core/plugin/provider/platform-keys"

const providers = [
  { id: "openai", models: [{ id: "gpt-5" }, { id: "gpt-4" }] },
  { id: "groq", integrationID: "groq", models: [{ id: "llama" }] },
  { id: "local", models: [{ id: "m" }] },
]
const signIn = Credential.OAuth.make({
  type: "oauth",
  methodID: Integration.MethodID.make("chatgpt"),
  access: "at-shared",
  refresh: ProjectVmManaged.MANAGED_REFRESH,
  expires: 9e12,
  metadata: { clientID: "c" },
})
const shared = [
  { id: "openai", integrationID: "openai", value: signIn, models: ["gpt-5"] },
  { id: "groq", integrationID: "groq", value: Credential.Key.make({ type: "key", key: "gsk" }), models: ["llama"] },
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

  test("each shared integration the user hasn't connected gets its credential, a sign-in without its refresh token", () => {
    expect(PlatformKeys.sharedCredentials(shared, new Set(["groq"]))).toEqual([
      { id: "cred_shared_openai", integrationID: "openai", label: "Shared", value: signIn },
    ])
    expect(PlatformKeys.sharedCredentials(shared, new Set(["openai"]))).toEqual([
      { id: "cred_shared_groq", integrationID: "groq", label: "Shared", value: { type: "key", key: "gsk" } },
    ])
  })

  test("a list saved by an older image (no credentials) is not read back", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "omai-keys-"))
    const file = path.join(dir, "platform-keys.json")
    await writeFile(file, JSON.stringify([{ id: "groq", integrationID: "groq", type: "key", models: ["llama"] }]))
    expect(await PlatformKeys.restore(file)).toEqual([])
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
