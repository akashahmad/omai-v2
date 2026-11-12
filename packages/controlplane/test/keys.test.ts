import { afterEach, describe, expect, test } from "bun:test"
import { createServer, type Server } from "node:http"
import { ModelUsageTable, UserCredentialTable } from "../src/db/schema.js"
import { Keys, MANAGED_REFRESH } from "../src/keys.js"
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
        integrationID: "openai",
        value: {
          type: "oauth",
          methodID: "chatgpt",
          access: "at-shared",
          refresh: "rt-shared",
          expires: 1,
          metadata: { clientID: "c" },
        },
        models: [
          { id: "gpt-5", api: "gpt-5" },
          { id: "gpt-4", api: "gpt-4" },
        ],
      },
      {
        id: "groq",
        integrationID: "groq",
        value: { type: "key", key: "gsk" },
        models: [{ id: "llama", api: "llama" }],
      },
    ],
  }
  const refreshes: unknown[] = []
  const exports = { count: 0 }
  const platformServer = await listen(
    createServer((req, res) => {
      if (req.headers["x-omai-platform-secret"] !== "s3") return res.writeHead(404).end()
      if (req.url === "/api/experimental/platform/providers") exports.count++
      if (req.url === "/api/experimental/platform/refresh") {
        const chunks: Buffer[] = []
        req.on("data", (chunk: Buffer) => chunks.push(chunk))
        req.on("end", () => {
          const input = JSON.parse(Buffer.concat(chunks).toString()) as { value: Record<string, unknown> }
          refreshes.push(input)
          // Slow, so two callers overlap.
          setTimeout(
            () =>
              res
                .writeHead(200)
                .end(JSON.stringify({ ...input.value, access: "at-new", refresh: "rt-new", expires: 9e12 })),
            50,
          )
        })
        return
      }
      res.writeHead(exported.status).end(JSON.stringify(exported.value))
    }),
  )
  const switched = { models: [{ providerID: "openai", modelID: "gpt-5" }] }
  const secrets = await Secrets.load(h.root, {})
  const keys = Keys.make({
    db: h.db,
    config: h.config,
    secrets,
    platform: {
      secret: "s3",
      address: async () => ({ vmID: "platform", host: platformServer, home: "/" }),
      models: async () => switched.models,
    },
    now: h.time.now,
  })
  return { ...h, keys, secrets, exported, switched, refreshes, exports }
}

describe("Keys", () => {
  test("shared: connected providers with their credential and only switched-on models, never a refresh token", async () => {
    const s = await setup()
    expect(await s.keys.shared()).toEqual([
      {
        id: "openai",
        integrationID: "openai",
        value: {
          type: "oauth",
          methodID: "chatgpt",
          access: "at-shared",
          refresh: MANAGED_REFRESH,
          expires: 1,
          metadata: { clientID: "c" },
        },
        models: ["gpt-5"],
      },
    ])
  })

  test("shared keeps the last good list when the platform server fails", async () => {
    const s = await setup()
    await s.keys.shared()
    s.exported.status = 500
    s.time.advance(60_000)
    expect(await s.keys.shared()).toEqual([
      {
        id: "openai",
        integrationID: "openai",
        value: {
          type: "oauth",
          methodID: "chatgpt",
          access: "at-shared",
          refresh: MANAGED_REFRESH,
          expires: 1,
          metadata: { clientID: "c" },
        },
        models: ["gpt-5"],
      },
    ])
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
    expect(await s.keys.shared()).toEqual([
      {
        id: "openai",
        integrationID: "openai",
        value: {
          type: "oauth",
          methodID: "chatgpt",
          access: "at-shared",
          refresh: MANAGED_REFRESH,
          expires: 1,
          metadata: { clientID: "c" },
        },
        models: ["gpt-5"],
      },
    ])
  })

  test("a credential that can't be decrypted is left out, never sent as empty", async () => {
    const s = await setup()
    await s.keys.put(s.a, { id: "c1", integrationID: "openai", label: "Mine", value: key("sk-a"), updatedAt: 1 })
    await s.db.update(UserCredentialTable).set({ value: "broken.sealed.value" })
    expect(await s.keys.personal(s.a)).toEqual([])
  })

  const signIn = (access: string, expires: number) => ({
    type: "oauth",
    methodID: "chatgpt",
    access,
    refresh: "rt-a",
    expires,
    metadata: { clientID: "c" },
  })

  test("a user's sign-in reaches their VMs with its access token, never its refresh token", async () => {
    const s = await setup()
    await s.keys.put(s.a, {
      id: "c1",
      integrationID: "openai",
      label: "ChatGPT",
      value: signIn("at-a", 9e12),
      updatedAt: 1,
    })
    const personal = await s.keys.personal(s.a)
    expect(personal).toEqual([
      {
        id: "c1",
        integrationID: "openai",
        label: "ChatGPT",
        value: { ...signIn("at-a", 9e12), refresh: MANAGED_REFRESH },
        updatedAt: 1,
        deleted: false,
      },
    ])
    expect(JSON.stringify(personal)).not.toContain("rt-a")
  })

  test("a sign-in pushed back with the managed refresh token keeps the stored one", async () => {
    const s = await setup()
    await s.keys.put(s.a, {
      id: "c1",
      integrationID: "openai",
      label: "ChatGPT",
      value: signIn("at-a", 9e12),
      updatedAt: 1,
    })
    expect(
      await s.keys.put(s.a, {
        id: "c1",
        integrationID: "openai",
        label: "Renamed",
        value: { ...signIn("at-b", 9e12), refresh: MANAGED_REFRESH },
        updatedAt: 2,
      }),
    ).toBe("ok")
    const [row] = await s.db.select().from(UserCredentialTable)
    expect(JSON.parse(s.secrets.open(row!.value!)!)).toMatchObject({ access: "at-b", refresh: "rt-a" })
    // With no real one stored, there is nothing to keep, so it is refused.
    expect(
      await s.keys.put(s.a, {
        id: "c2",
        integrationID: "openai",
        label: "New",
        value: { ...signIn("at-c", 9e12), refresh: MANAGED_REFRESH },
        updatedAt: 3,
      }),
    ).toBe("stale")
    // Neither does a stand-in from a VM on an older image.
    expect(
      await s.keys.put(s.a, {
        id: "c1",
        integrationID: "openai",
        label: "x",
        value: signIn("omai-gw.u~c1", 1),
        updatedAt: 9,
      }),
    ).toBe("stale")
  })

  test("a sign-in about to expire is refreshed once, here, for every VM", async () => {
    const s = await setup()
    await s.keys.put(s.a, {
      id: "c1",
      integrationID: "openai",
      label: "ChatGPT",
      value: signIn("at-old", 1),
      updatedAt: 1,
    })
    const [first, second] = await Promise.all([s.keys.refresh(s.a, "u~c1"), s.keys.refresh(s.a, "u~c1")])
    expect(first).toEqual({ access: "at-new", expires: 9e12 })
    expect(second).toEqual({ access: "at-new", expires: 9e12 })
    expect(s.refreshes).toHaveLength(1)
    expect(s.refreshes[0]).toMatchObject({ integrationID: "openai", value: { access: "at-old", refresh: "rt-a" } })
    // Stored, so the next ask needs no refresh, and VMs pull the new token.
    expect(await s.keys.refresh(s.a, "u~c1")).toEqual({ access: "at-new", expires: 9e12 })
    expect(s.refreshes).toHaveLength(1)
    expect((await s.keys.personal(s.a))[0]?.value).toMatchObject({ access: "at-new", refresh: MANAGED_REFRESH })
  })

  test("refresh answers only for the user's own sign-ins and switched-on shared ones", async () => {
    const s = await setup()
    await s.keys.put(s.a, {
      id: "c1",
      integrationID: "openai",
      label: "ChatGPT",
      value: signIn("at-a", 9e12),
      updatedAt: 1,
    })
    await s.keys.put(s.a, { id: "k1", integrationID: "openai", label: "Key", value: key("sk-a"), updatedAt: 1 })
    expect(await s.keys.refresh(s.b, "u~c1")).toBeUndefined()
    expect(await s.keys.refresh(s.a, "u~k1")).toBeUndefined()
    expect(await s.keys.refresh(s.a, "nope")).toBeUndefined()
    // groq has no switched-on models, and is an API key anyway.
    expect(await s.keys.refresh(s.b, "s~groq")).toBeUndefined()
  })

  test("a shared sign-in about to expire is asked of the platform server again, which refreshes it", async () => {
    const s = await setup()
    await s.keys.shared()
    const before = s.exports.count
    Object.assign(s.exported.value[0]!.value, { access: "at-shared-new", expires: 9e12 })
    expect(await s.keys.refresh(s.b, "s~openai")).toEqual({ access: "at-shared-new", expires: 9e12 })
    expect(s.exports.count).toBe(before + 1)
    // With time left, the cached one is answered without asking again.
    expect(await s.keys.refresh(s.b, "s~openai")).toEqual({ access: "at-shared-new", expires: 9e12 })
    expect(s.exports.count).toBe(before + 1)
  })
})
