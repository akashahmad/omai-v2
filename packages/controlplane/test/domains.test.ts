import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { fakeCloudflare } from "../../core/test/publish/fake-cloudflare.js"
import { PublishedSiteTable } from "../src/db/schema.js"
import { Domains } from "../src/domains.js"
import { Locks } from "../src/locks.js"
import { Publishing } from "../src/publishing.js"
import { Refusal } from "../src/publishing.js"
import { harness } from "./fixture/setup.js"

const cleanup: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
})

let fake: Awaited<ReturnType<typeof fakeCloudflare>>
beforeAll(async () => {
  fake = await fakeCloudflare()
})
afterAll(() => fake.close())

/** What the fake resolver answers, by host. Unknown hosts resolve to nothing. */
const dns = new Map<string, { cname: string[]; a: string[]; txt?: string[] }>()

async function setup() {
  const h = await harness()
  cleanup.push(() => h.provider.close())
  const clock = { now: Date.parse("2026-11-06T10:00:00Z") }
  const locks = Locks.make()
  const publishing = Publishing.make({
    db: h.db,
    config: { cloudflare: fake.config, dataDir: h.root, publishMaxBytes: 1024, publishConcurrency: 1 },
    locks,
  })
  const domains = Domains.make({
    db: h.db,
    locks,
    config: { cloudflare: fake.config },
    resolve: async (host) => dns.get(host) ?? { cname: [], a: [] },
    now: () => clock.now,
  })
  /** A project of `userID` with a published site named `name`. */
  const site = async (userID: string, name: string) => {
    const created = await h.projects.create(userID, name)
    if (typeof created === "string") throw new Error(created)
    await h.db
      .insert(PublishedSiteTable)
      .values({ id: `site-${name}`, project_id: created.id, user_id: userID, name, published_at: new Date() })
    return created.id
  }
  return { ...h, domains, publishing, site, clock }
}

async function refusal(promise: Promise<unknown>) {
  return promise.then(
    () => undefined,
    (error: unknown) => (error instanceof Refusal ? error : Promise.reject(error)),
  )
}

const kv = (host: string) => fake.state.kv.get(host)

describe("Domains", () => {
  test("a hostname another project owns is taken", async () => {
    const s = await setup()
    const mine = await s.site(s.a, "dom-mine")
    const theirs = await s.site(s.b, "dom-theirs")
    await s.domains.add(mine, "www.taken.edu")
    expect((await refusal(s.domains.add(theirs, "www.taken.edu")))?.kind).toBe("taken")
    expect((await refusal(s.domains.remove(theirs, "www.taken.edu")))?.kind).toBe("invalid")
    expect((await refusal(s.domains.setPrimary(theirs, "www.taken.edu")))?.kind).toBe("invalid")
    expect((await s.domains.list(theirs)).domains).toEqual([])
    expect(kv("www.taken.edu")).toBe(JSON.stringify({ script: "dom-mine" }))
  })

  test("domains need a published site", async () => {
    const s = await setup()
    const created = await s.projects.create(s.a, "Unpublished")
    if (typeof created === "string") throw new Error(created)
    expect((await refusal(s.domains.add(created.id, "www.early.edu")))?.kind).toBe("not-published")
  })

  test("removing the primary promotes the oldest active", async () => {
    const s = await setup()
    const id = await s.site(s.a, "dom-promote")
    await s.domains.add(id, "one.promote.edu")
    s.clock.now += 1000
    await s.domains.add(id, "two.promote.edu")
    s.clock.now += 1000
    await s.domains.add(id, "three.promote.edu")
    fake.state.hostnames.get("three.promote.edu")!.status = "active"
    fake.state.hostnames.get("three.promote.edu")!.ssl.status = "active"
    await s.domains.check(id)
    const removed = await s.domains.remove(id, "one.promote.edu")
    expect(removed.domains.find((domain) => domain.primary)?.hostname).toBe("three.promote.edu")
    expect(fake.state.hostnames.has("one.promote.edu")).toBe(false)
    expect(kv("one.promote.edu")).toBeUndefined()
    expect(kv("two.promote.edu")).toBe(JSON.stringify({ redirect: "three.promote.edu" }))
    expect(kv("dom-promote.omai.test")).toBe(JSON.stringify({ redirect: "three.promote.edu" }))
  })

  test("check writes only changed routes", async () => {
    const s = await setup()
    const id = await s.site(s.a, "dom-check")
    await s.domains.add(id, "www.check.edu")
    const writes = () => fake.state.requests.filter((request) => request.method === "PUT" && request.path.includes("/values/")).length
    s.clock.now += 10_001
    const before = writes()
    await s.domains.check(id)
    expect(writes()).toBe(before)
    fake.state.hostnames.get("www.check.edu")!.status = "active"
    fake.state.hostnames.get("www.check.edu")!.ssl.status = "active"
    s.clock.now += 10_001
    const checked = await s.domains.check(id)
    expect(checked.domains[0]?.status).toBe("active")
    expect(writes()).toBe(before + 1)
    expect(kv("dom-check.omai.test")).toBe(JSON.stringify({ redirect: "www.check.edu" }))
  })

  test("a flattened root domain needs its TXT record", async () => {
    const s = await setup()
    const id = await s.site(s.a, "dom-apex")
    dns.set("domains.omai.test", { cname: [], a: ["192.0.2.1"] })
    dns.set("apex.edu", { cname: [], a: ["192.0.2.1"] })
    const added = await s.domains.add(id, "apex.edu")
    const token = added.domains[0]?.verification?.value ?? ""
    expect(token).not.toBe("")
    expect(added.domains[0]?.records).toEqual([
      { type: "ALIAS", name: "apex.edu", value: "domains.omai.test", ok: true },
      { type: "TXT", name: "_cf-custom-hostname.apex.edu", value: token, ok: false },
    ])
  })

  test("removing the site while a domain is added leaves no hostname behind", async () => {
    const s = await setup()
    const id = await s.site(s.a, "dom-race")
    await Promise.all([refusal(s.domains.add(id, "www.race.edu")), s.publishing.remove(id, "dom-race")])
    expect(fake.state.hostnames.has("www.race.edu")).toBe(false)
    expect(kv("www.race.edu")).toBeUndefined()
  })

  test("a deleted domain can be added again", async () => {
    const s = await setup()
    const id = await s.site(s.a, "dom-again")
    await s.domains.add(id, "www.again.edu")
    await s.domains.remove(id, "www.again.edu")
    const again = await s.domains.add(id, "www.again.edu")
    expect(again.domains.map((domain) => domain.hostname)).toEqual(["www.again.edu"])
  })
})
