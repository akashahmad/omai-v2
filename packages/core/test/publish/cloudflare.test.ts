import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { Cloudflare } from "../../src/publish/cloudflare"
import { PublishConfig } from "../../src/publish/config"
import { fakeCloudflare } from "./fake-cloudflare"

let fake: Awaited<ReturnType<typeof fakeCloudflare>>
beforeAll(async () => {
  fake = await fakeCloudflare()
})
afterAll(() => fake.close())

describe("publish config", () => {
  test("read needs an account and a token, and applies defaults", () => {
    expect(PublishConfig.read({})).toBeUndefined()
    expect(PublishConfig.read({ OMAI_CLOUDFLARE_ACCOUNT_ID: "a" })).toBeUndefined()
    expect(
      PublishConfig.read({
        OMAI_CLOUDFLARE_ACCOUNT_ID: "a",
        OMAI_CLOUDFLARE_API_TOKEN: "t",
        OMAI_CLOUDFLARE_APEX_IPS: "1.1.1.1, 2.2.2.2,",
      }),
    ).toEqual({
      accountID: "a",
      token: "t",
      zone: "omai.ch",
      namespace: "omai-apps",
      apexIPs: ["1.1.1.1", "2.2.2.2"],
      api: "https://api.cloudflare.com/client/v4",
    })
    expect(PublishConfig.target("omai.ch")).toBe("domains.omai.ch")
  })
})

describe("cloudflare client", () => {
  test("scriptExists treats a null script as absent", async () => {
    const cf = Cloudflare.client(fake.config)
    expect(await cf.scriptExists("missing")).toBe(false)
    await cf.claimScript("present", "proj-1")
    expect(await cf.scriptExists("present")).toBe(true)
    expect(await cf.scriptOwner("present")).toBe("proj-1")
    expect(await cf.scriptOwner("missing")).toBeUndefined()
    await cf.deleteScript("present")
    await cf.deleteScript("present")
    expect(await cf.scriptExists("present")).toBe(false)
  })

  test("kvDelete ignores 404", async () => {
    const cf = Cloudflare.client(fake.config)
    await cf.kvPut("a.example.com", "my-app")
    expect(await cf.kvGet("a.example.com")).toBe("my-app")
    await cf.kvDelete("a.example.com")
    await cf.kvDelete("a.example.com")
    expect(await cf.kvGet("a.example.com")).toBeUndefined()
  })

  test("addHostname returns the ownership TXT record", async () => {
    const cf = Cloudflare.client(fake.config)
    const added = await cf.addHostname("shop.example.com")
    expect(added.ownership).toEqual({
      name: "_cf-custom-hostname.shop.example.com",
      value: "token-1",
    })
    expect((await cf.getHostname("shop.example.com"))?.id).toBe(added.id)
    expect(await cf.getHostname("nope.example.com")).toBeUndefined()
    await cf.deleteHostname(added.id)
    await cf.deleteHostname(added.id)
    expect(await cf.getHostname("shop.example.com")).toBeUndefined()
  })

  test("getHostname answers only the exact hostname, whatever the list puts first", async () => {
    const cf = Cloudflare.client(fake.config)
    fake.state.similarHostnames = [
      { id: "ch-similar", hostname: "www.match.example.com", status: "active", ssl: { status: "active" } },
    ]
    try {
      expect(await cf.getHostname("match.example.com")).toBeUndefined()
      const added = await cf.addHostname("match.example.com")
      expect((await cf.getHostname("match.example.com"))?.id).toBe(added.id)
      await cf.deleteHostname(added.id)
    } finally {
      fake.state.similarHostnames = []
    }
  })

  test("hasRecord and memoised zone and kv ids", async () => {
    const cf = Cloudflare.client(fake.config)
    fake.state.records.set("taken.omai.test", "A")
    expect(await cf.hasRecord("taken.omai.test")).toBe(true)
    expect(await cf.hasRecord("free.omai.test")).toBe(false)
    // hasRecord already resolved the zone, so only the first kvID call reaches the API.
    const before = fake.state.requests.length
    expect(await cf.zoneID()).toBe("zone-1")
    expect(await cf.kvID()).toBe("kv-1")
    expect(fake.state.requests.length).toBe(before + 1)
    expect(await cf.kvID()).toBe("kv-1")
    expect(fake.state.requests.length).toBe(before + 1)
    expect(fake.state.requests.every((r) => r.auth === "Bearer secret-token")).toBe(true)
  })

  test("a read-only client refuses writes before sending them", async () => {
    const cf = Cloudflare.client(fake.config, Cloudflare.TIMEOUT, { readOnly: true })
    const before = fake.state.requests.length
    await expect(cf.createRoute("x.omai.test/*")).rejects.toThrow("Read-only")
    await expect(cf.kvPut("x.omai.test", "x")).rejects.toThrow("Read-only")
    expect(fake.state.requests.slice(before).filter((r) => r.method !== "GET")).toEqual([])
    expect(await cf.namespaceExists()).toBe(true)
  })

  test("platform setup reads: records across pages, routes, namespaces and the fallback origin", async () => {
    const cf = Cloudflare.client(fake.config)
    Array.from({ length: 150 }, (_, i) => fake.state.records.set(`r${i}.omai.test`, "A"))
    expect((await cf.records()).filter((r) => r.name.startsWith("r") && r.type === "A").length).toBe(150)
    expect(await cf.namespaceExists()).toBe(true)
    expect(await Cloudflare.client({ ...fake.config, namespace: "other" }).namespaceExists()).toBe(false)
    expect(await cf.findKv()).toBe("kv-1")
    expect(await cf.workerExists("omai-dispatcher")).toBe(false)
    expect(await cf.fallbackOrigin()).toBeUndefined()
    await cf.setFallbackOrigin("fallback.omai.test")
    expect(await cf.fallbackOrigin()).toBe("fallback.omai.test")
    await cf.createRoute("a.omai.test/*")
    await cf.createRoute("*/*", "omai-dispatcher")
    expect((await cf.routes()).map((r) => [r.pattern, r.script])).toEqual([
      ["a.omai.test/*", undefined],
      ["*/*", "omai-dispatcher"],
    ])
  })

  test("fallbackOrigin is unset only for a 404 or a null result, and throws on any other shape", async () => {
    const cf = Cloudflare.client({ ...fake.config, zone: "origin.test" })
    fake.state.zones.add("origin.test")
    fake.state.fallbackOriginResult = null
    expect(await cf.fallbackOrigin()).toBeUndefined()
    fake.state.fallbackOriginResult = { hostname: "fallback.omai.test" }
    await expect(cf.fallbackOrigin()).rejects.toThrow("Unexpected Cloudflare fallback origin response")
    fake.state.fallbackOriginResult = "fallback.omai.test"
    await expect(cf.fallbackOrigin()).rejects.toThrow("Unexpected Cloudflare fallback origin response")
    fake.state.fallbackOriginResult = { origin: "fallback.omai.test", status: "active" }
    expect(await cf.fallbackOrigin()).toBe("fallback.omai.test")
    fake.state.fallbackOriginResult = undefined
  })

  test("a failed zone lookup is not cached", async () => {
    const cf = Cloudflare.client({ ...fake.config, zone: "late.test" })
    await expect(cf.zoneID()).rejects.toThrow("Zone not found")
    fake.state.zones.add("late.test")
    expect(await cf.zoneID()).toBe("zone-1")
  })

  test("error codes survive an entry without a message", async () => {
    fake.state.failing = { status: 400, code: 1404, message: undefined }
    const error = await Cloudflare.client(fake.config)
      .hasRecord("x.omai.test")
      .then(
        () => undefined,
        (e: unknown) => e,
      )
    fake.state.failing = undefined
    expect(error).toBeInstanceOf(Cloudflare.CloudflareError)
    if (!(error instanceof Cloudflare.CloudflareError)) return
    expect(error.codes).toEqual([1404])
    expect(error.message).toBe("Cloudflare API 400")
  })

  test("hostnameStatus is active only when hostname and ssl are active", () => {
    const h = (status: string, ssl: string) => ({
      id: "1",
      hostname: "x.com",
      status,
      ssl: { status: ssl },
    })
    expect(Cloudflare.hostnameStatus(h("active", "active"))).toBe("active")
    expect(Cloudflare.hostnameStatus(h("active", "pending_validation"))).toBe("pending")
    expect(Cloudflare.hostnameStatus(h("pending", "active"))).toBe("pending")
    expect(Cloudflare.hostnameStatus(h("blocked", "active"))).toBe("error")
    expect(Cloudflare.hostnameStatus(h("active", "validation_timed_out"))).toBe("error")
  })

  test("errors carry Cloudflare's message, not the raw body", async () => {
    const cf = Cloudflare.client(fake.config)
    fake.state.failing = {
      status: 403,
      code: 9109,
      message: "Invalid access token",
    }
    const error = await cf.hasRecord("x.omai.test").then(
      () => undefined,
      (e: unknown) => e,
    )
    fake.state.failing = undefined
    expect(error).toBeInstanceOf(Cloudflare.CloudflareError)
    if (!(error instanceof Cloudflare.CloudflareError)) return
    expect(error.status).toBe(403)
    expect(error.codes).toEqual([9109])
    expect(error.message).toBe("Invalid access token")
    expect(error.message).not.toContain("raw-body-detail")
  })

  test("a request that gets no answer fails in time with a plain message", async () => {
    const cf = Cloudflare.client(fake.config, 100)
    await cf.zoneID()
    fake.state.hanging = true
    const error = await cf.hasRecord("slow.omai.test").then(
      () => undefined,
      (e: unknown) => e,
    )
    fake.state.hanging = false
    expect(error).toBeInstanceOf(Cloudflare.CloudflareError)
    if (!(error instanceof Cloudflare.CloudflareError)) return
    expect(error.message).toBe("Cloudflare didn't respond in time.")
  })
})
