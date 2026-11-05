import { afterEach, describe, expect, test } from "bun:test"
import { setup, type WranglerConfig } from "../../script/publish-platform"
import { fakeCloudflare } from "./fake-cloudflare"

const fakes: Awaited<ReturnType<typeof fakeCloudflare>>[] = []

afterEach(async () => {
  await Promise.all(fakes.splice(0).map((fake) => fake.close()))
})

/** A fake account with nothing set up except one existing host record and a TXT record. */
async function bare() {
  const fake = await fakeCloudflare()
  fakes.push(fake)
  fake.state.namespaces.clear()
  fake.state.kvNamespaces.clear()
  fake.state.records.set("mail.omai.test", "A")
  fake.state.records.set("_dmarc.omai.test", "TXT")
  return fake
}

async function run(fake: Awaited<ReturnType<typeof fakeCloudflare>>, dryRun: boolean) {
  const lines: string[] = []
  const deploys: WranglerConfig[] = []
  const result = await setup(fake.config, {
    dryRun,
    log: (line) => lines.push(line),
    deploy: async (wrangler) => {
      deploys.push(wrangler)
    },
  })
  return { lines, deploys, conflicts: result.conflicts }
}

describe("publish platform setup", () => {
  test("a dry run only reads and reports what it would create", async () => {
    const fake = await bare()
    const result = await run(fake, true)
    expect(fake.state.requests.length).toBeGreaterThan(0)
    expect(fake.state.requests.filter((r) => r.method !== "GET")).toEqual([])
    expect(result.deploys).toEqual([])
    expect(result.lines).toContain("would create  dispatch namespace ns")
    expect(result.lines).toContain("would create  kv namespace omai-hostnames")
    expect(result.lines).toContain("would create  dns *.omai.test")
    expect(result.lines).toContain("would create  route mail.omai.test/* -> (bypass)")
    expect(result.lines).toContain("would deploy  worker omai-dispatcher (new)")
    expect(result.lines).toContain("would create  route */* -> omai-dispatcher")
    expect(fake.state.namespaces.size).toBe(0)
    expect(fake.state.routes).toEqual([])
  })

  test("a real run creates what is missing and a second run creates nothing", async () => {
    const fake = await bare()
    const first = await run(fake, false)
    expect(fake.state.namespaces.has("ns")).toBe(true)
    expect(fake.state.kvNamespaces.has("omai-hostnames")).toBe(true)
    expect(fake.state.records.get("*.omai.test")).toBe("AAAA")
    expect(fake.state.records.get("fallback.omai.test")).toBe("AAAA")
    expect(fake.state.fallbackOrigin).toBe("fallback.omai.test")
    const patterns = new Map(fake.state.routes.map((r) => [r.pattern, r.script]))
    expect(patterns.get("*.omai.test/*")).toBe("omai-dispatcher")
    expect(patterns.get("*/*")).toBe("omai-dispatcher")
    expect(patterns.has("omai.test/*")).toBe(true)
    expect(patterns.get("mail.omai.test/*")).toBeUndefined()
    expect(patterns.has("mail.omai.test/*")).toBe(true)
    expect(patterns.has("www.omai.test/*")).toBe(true)
    // `domains` is only a CNAME target and TXT records carry no traffic, so neither gets a bypass route.
    expect(patterns.has("domains.omai.test/*")).toBe(false)
    expect(patterns.has("_dmarc.omai.test/*")).toBe(false)
    expect(first.deploys).toEqual([
      expect.objectContaining({
        name: "omai-dispatcher",
        compatibility_date: "2026-10-30",
        dispatch_namespaces: [{ binding: "DISPATCHER", namespace: "ns" }],
        kv_namespaces: [{ binding: "HOSTNAMES", id: fake.state.kvNamespaces.get("omai-hostnames") }],
        vars: { ZONE: "omai.test" },
        workers_dev: false,
        preview_urls: false,
      }),
    ])
    expect(first.lines.some((line) => line.startsWith("created  "))).toBe(true)

    fake.state.workers.add("omai-dispatcher")
    const writes = fake.state.requests.filter((r) => r.method !== "GET").length
    const second = await run(fake, false)
    expect(fake.state.requests.filter((r) => r.method !== "GET").length).toBe(writes)
    expect(second.lines.filter((line) => line.startsWith("created") || line.startsWith("would"))).toEqual([])
    expect(second.lines).toContain("deployed  worker omai-dispatcher (replaces the live version)")
    expect(second.deploys.length).toBe(1)
    expect(second.conflicts).toEqual([])
  })

  test("a dry run against a provisioned account prints only exists lines and the dispatcher redeploy", async () => {
    const fake = await bare()
    await run(fake, false)
    fake.state.workers.add("omai-dispatcher")
    const before = fake.state.requests.length
    const result = await run(fake, true)
    expect(fake.state.requests.slice(before).filter((r) => r.method !== "GET")).toEqual([])
    expect(result.deploys).toEqual([])
    expect(result.conflicts).toEqual([])
    const actions = result.lines.filter((line) => line.trim() !== "" && !line.startsWith("\nRe-run"))
    expect(actions.filter((line) => !line.startsWith("exists  "))).toEqual([
      "would deploy  worker omai-dispatcher (replaces the live version)",
    ])
    expect(actions.length).toBeGreaterThan(10)
  })

  test("a fallback origin response it cannot read stops the run before anything is written there", async () => {
    const fake = await bare()
    fake.state.fallbackOriginResult = { hostname: "fallback.omai.test" }
    await expect(run(fake, false)).rejects.toThrow("Unexpected Cloudflare fallback origin response")
    expect(fake.state.requests.some((r) => r.method === "PUT" && r.path.endsWith("/fallback_origin"))).toBe(false)
  })

  test("existing routes, records and fallback origins are left alone", async () => {
    const fake = await fakeCloudflare()
    fakes.push(fake)
    fake.state.records.set("*.omai.test", "CNAME")
    fake.state.fallbackOrigin = "origin.omai.test"
    fake.state.routes.push({ id: "old-1", pattern: "*/*", script: "old-dispatcher" })
    fake.state.routes.push({ id: "old-2", pattern: "www.omai.test/*", script: "old-site" })
    const result = await run(fake, false)
    expect(fake.state.routes.find((r) => r.id === "old-1")?.script).toBe("old-dispatcher")
    expect(fake.state.routes.find((r) => r.id === "old-2")?.script).toBe("old-site")
    expect(fake.state.routes.filter((r) => r.pattern === "*/*").length).toBe(1)
    expect(result.conflicts).toEqual([
      "conflict  route www.omai.test/* -> (bypass): already points to old-site; left alone",
      "conflict  route */* -> omai-dispatcher: already points to old-dispatcher; left alone",
    ])
    expect(fake.state.records.get("*.omai.test")).toBe("CNAME")
    expect(fake.state.records.has("fallback.omai.test")).toBe(false)
    expect(fake.state.fallbackOrigin).toBe("origin.omai.test")
    expect(result.lines).toContain("exists  fallback origin origin.omai.test (expected fallback.omai.test; left alone)")
    expect(result.lines).toContain("exists  dispatch namespace ns")
    expect(result.lines).toContain("exists  kv namespace omai-hostnames")
  })
})
