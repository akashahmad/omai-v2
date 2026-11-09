import { afterEach, describe, expect, test } from "bun:test"
import { createServer, type Server } from "node:http"
import { ModelUsageTable, UserCredentialTable } from "../src/db/schema.js"
import { Keys } from "../src/keys.js"
import { Secrets } from "../src/secrets.js"
import { harness } from "./fixture/setup.js"

const cleanup: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
})

function listen(server: Server) {
  return new Promise<string>((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      cleanup.push(() => new Promise<void>((done) => server.close(() => done())))
      cleanup.push(() => server.closeAllConnections())
      resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}`)
    }),
  )
}

const key = (value: string) => ({ type: "key", key: value })

async function setup() {
  const h = await harness()
  cleanup.push(() => h.provider.close())
  const exported = {
    status: 200,
    value: [
      {
        id: "openai",
        auth: "bearer",
        key: "sk-shared",
        bases: ["https://api.openai.com/v1"],
        models: [
          { id: "gpt-5", api: "gpt-5" },
          { id: "gpt-4", api: "gpt-4" },
        ],
      },
      {
        id: "groq",
        auth: "bearer",
        key: "gsk",
        bases: ["https://api.groq.com"],
        models: [{ id: "llama", api: "llama" }],
      },
    ],
  }
  const platformServer = await listen(
    createServer((req, res) => {
      if (req.headers["x-omai-platform-secret"] !== "s3") return res.writeHead(404).end()
      res.writeHead(exported.status).end(JSON.stringify(exported.value))
    }),
  )
  const switched = { models: [{ providerID: "openai", modelID: "gpt-5" }] }
  const keys = Keys.make({
    db: h.db,
    config: h.config,
    secrets: await Secrets.load(h.root, {}),
    platform: {
      secret: "s3",
      address: async () => ({ vmID: "platform", host: platformServer, home: "/" }),
      models: async () => switched.models,
    },
    now: h.time.now,
  })
  return { ...h, keys, exported, switched }
}

describe("Keys", () => {
  test("shared: connected providers with their real key and only switched-on models", async () => {
    const s = await setup()
    expect(await s.keys.shared()).toEqual([{ id: "openai", key: "sk-shared", models: ["gpt-5"] }])
  })

  test("shared keeps the last good list when the platform server fails", async () => {
    const s = await setup()
    await s.keys.shared()
    s.exported.status = 500
    s.time.advance(60_000)
    expect(await s.keys.shared()).toEqual([{ id: "openai", key: "sk-shared", models: ["gpt-5"] }])
  })

  test("personal credentials belong to one user", async () => {
    const s = await setup()
    expect(
      await s.keys.put(s.a, { id: "c1", integrationID: "openai", label: "Mine", value: key("sk-a"), updatedAt: 1 }),
    ).toBe("ok")
    expect(
      await s.keys.put(s.b, { id: "c1", integrationID: "openai", label: "Hijack", value: key("sk-b"), updatedAt: 2 }),
    ).toBe("forbidden")
    expect(await s.keys.personal(s.b)).toEqual([])
    expect(await s.keys.personal(s.a)).toEqual([
      { id: "c1", integrationID: "openai", label: "Mine", value: key("sk-a"), updatedAt: 1, deleted: false },
    ])
    expect(await s.keys.remove(s.b, "c1", 5)).toBe("forbidden")
  })

  test("the newer write wins; a delete leaves a tombstone", async () => {
    const s = await setup()
    await s.keys.put(s.a, { id: "c1", integrationID: "openai", label: "One", value: key("sk-1"), updatedAt: 10 })
    expect(
      await s.keys.put(s.a, { id: "c1", integrationID: "openai", label: "Old", value: key("sk-0"), updatedAt: 5 }),
    ).toBe("stale")
    await s.keys.put(s.a, { id: "c1", integrationID: "openai", label: "Two", value: key("sk-2"), updatedAt: 20 })
    expect((await s.keys.personal(s.a))[0]).toMatchObject({ label: "Two", value: key("sk-2") })
    expect(await s.keys.remove(s.a, "c1", 30)).toBe("ok")
    expect(await s.keys.personal(s.a)).toEqual([
      { id: "c1", integrationID: "openai", label: "", value: null, updatedAt: 30, deleted: true },
    ])
    // A stale write after the delete does not bring it back; a newer one does.
    expect(
      await s.keys.put(s.a, { id: "c1", integrationID: "openai", label: "Late", value: key("sk-3"), updatedAt: 25 }),
    ).toBe("stale")
    expect(
      await s.keys.put(s.a, { id: "c1", integrationID: "openai", label: "Back", value: key("sk-4"), updatedAt: 40 }),
    ).toBe("ok")
    expect((await s.keys.personal(s.a))[0]).toMatchObject({ deleted: false, value: key("sk-4") })
  })

  test("usage reports become rows", async () => {
    const s = await setup()
    const id = await s.running()
    await s.keys.usage(s.a, id, [{ providerID: "openai", modelID: "gpt-5", inputTokens: 3, outputTokens: 4, at: 1000 }])
    expect(await s.db.select().from(ModelUsageTable)).toMatchObject([
      {
        user_id: s.a,
        project_id: id,
        provider_id: "openai",
        model_id: "gpt-5",
        input_tokens: 3,
        output_tokens: 4,
        status: 200,
      },
    ])
  })

  test("unknown is not empty: with no good list yet, shared is undefined so VMs keep their copy", async () => {
    const s = await setup()
    s.exported.status = 500
    expect(await s.keys.shared()).toBeUndefined()
    s.exported.status = 200
    // A failure is not cached: the next ask succeeds at once.
    expect(await s.keys.shared()).toEqual([{ id: "openai", key: "sk-shared", models: ["gpt-5"] }])
  })

  test("a credential that can't be decrypted is left out, never sent as empty", async () => {
    const s = await setup()
    await s.keys.put(s.a, { id: "c1", integrationID: "openai", label: "Mine", value: key("sk-a"), updatedAt: 1 })
    await s.db.update(UserCredentialTable).set({ value: "broken.sealed.value" })
    expect(await s.keys.personal(s.a)).toEqual([])
  })
})
