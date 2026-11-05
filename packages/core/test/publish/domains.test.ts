import { afterAll, beforeAll, describe, expect } from "bun:test"
import path from "node:path"
import { eq } from "drizzle-orm"
import { Effect, Exit, Fiber, Layer, Stream } from "effect"
import { Database } from "@opencode/core/database/database"
import { PublishDomains } from "@opencode/core/publish/domains"
import { PublishDomainTable, PublishSiteTable } from "@opencode/core/publish/sql"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { Global } from "@opencode/util/global"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { tmpdir } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"
import { fakeCloudflare } from "./fake-cloudflare"

const saved = { ...process.env }
let fake: Awaited<ReturnType<typeof fakeCloudflare>>
let root: Awaited<ReturnType<typeof tmpdir>>
const paths = { data: "" }
/** What the fake resolver answers, by host. Unknown hosts resolve to nothing. */
const dns = new Map<string, { cname: string[]; a: string[] }>()

beforeAll(async () => {
  fake = await fakeCloudflare()
  root = await tmpdir("omai-publish-domains-")
  paths.data = path.join(root.path, "data")
  Object.assign(process.env, {
    OMAI_CLOUDFLARE_ACCOUNT_ID: fake.config.accountID,
    OMAI_CLOUDFLARE_API_TOKEN: fake.config.token,
    OMAI_CLOUDFLARE_PLATFORM_ZONE: fake.config.zone,
    OMAI_CLOUDFLARE_API_BASE: fake.config.api,
  })
})

afterAll(async () => {
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]
  Object.assign(process.env, saved)
  await fake.close()
  await root[Symbol.asyncDispose]()
})

const domainsNode = makeGlobalNode({
  service: PublishDomains.Service,
  layer: PublishDomains.layerWith(async (host) => dns.get(host) ?? { cname: [], a: [] }),
  deps: [Database.node, Global.node],
})

const it = testEffect(
  LayerNode.compile(LayerNode.group([domainsNode, Database.node]), {
    // The data directory is set in beforeAll, after this layer is defined.
    replacements: [Global.node.replace(Layer.unwrap(Effect.sync(() => Global.layerWith({ data: paths.data }))))],
  }),
)

const site = Effect.fnUntraced(function* (projectID: string, name: string) {
  const db = (yield* Database.Service).db
  const now = Date.now()
  yield* db
    .insert(PublishSiteTable)
    .values({ project_id: projectID, name, kind: "static", time_published: now, time_created: now, time_updated: now })
    .run()
    .pipe(Effect.orDie)
})

const activate = (host: string) => {
  const entry = fake.state.hostnames.get(host)
  if (!entry) throw new Error(`no custom hostname ${host}`)
  entry.status = "active"
  entry.ssl = { status: "active" }
}

const kv = (host: string) => fake.state.kv.get(host)
const hostnameReads = () =>
  fake.state.requests.filter((request) => request.method === "GET" && request.path.endsWith("/custom_hostnames")).length

const kvWrites = () =>
  fake.state.requests.filter(
    (request) => (request.method === "PUT" || request.method === "DELETE") && request.path.includes("/storage/kv/"),
  ).length

const failureOf = <A>(exit: Exit.Exit<A, PublishDomains.PublishError>) => {
  if (Exit.isSuccess(exit)) throw new Error("expected a failure")
  const error = exit.cause.reasons.find((reason) => reason._tag === "Fail")
  return error?._tag === "Fail" ? error.error : undefined
}

describe("PublishDomains", () => {
  it.live("first domain becomes primary and routes to the script", () =>
    Effect.gen(function* () {
      const domains = yield* PublishDomains.Service
      yield* site("prj_first", "first-app")

      const result = yield* domains.add("prj_first", "https://WWW.First.edu/")

      expect(result.site?.name).toBe("first-app")
      expect(result.subdomain).toEqual({ host: "first-app.omai.test", redirects: false })
      expect(result.domains).toHaveLength(1)
      const domain = result.domains[0]
      expect(domain?.hostname).toBe("www.first.edu")
      expect(domain?.primary).toBe(true)
      expect(domain?.status).toBe("pending")
      expect(domain?.apex).toBe(false)
      expect(domain?.records).toEqual([{ type: "CNAME", name: "www.first.edu", value: "domains.omai.test", ok: false }])
      expect(domain?.verification).toEqual({
        type: "TXT",
        name: "_cf-custom-hostname.www.first.edu",
        value: "token-1",
      })
      expect(fake.state.hostnames.has("www.first.edu")).toBe(true)
      expect(kv("www.first.edu")).toBe(JSON.stringify({ script: "first-app" }))
      expect(kv("first-app.omai.test")).toBeUndefined()
    }),
  )

  it.live("alias redirect is written once the primary turns active", () =>
    Effect.gen(function* () {
      const domains = yield* PublishDomains.Service
      yield* site("prj_alias", "alias-app")
      yield* domains.add("prj_alias", "www.x.edu")
      yield* domains.add("prj_alias", "x.edu")
      expect(kv("x.edu")).toBe(JSON.stringify({ script: "alias-app" }))

      activate("www.x.edu")
      dns.set("www.x.edu", { cname: ["Domains.Omai.Test."], a: [] })
      const result = yield* domains.check("prj_alias")

      expect(kv("x.edu")).toBe(JSON.stringify({ redirect: "www.x.edu" }))
      expect(kv("www.x.edu")).toBe(JSON.stringify({ script: "alias-app" }))
      expect(kv("alias-app.omai.test")).toBe(JSON.stringify({ redirect: "www.x.edu" }))
      expect(result.subdomain).toEqual({ host: "alias-app.omai.test", redirects: true })
      const primary = result.domains.find((domain) => domain.hostname === "www.x.edu")
      expect(primary?.status).toBe("active")
      expect(primary?.ssl).toBe("active")
      expect(primary?.records[0]?.ok).toBe(true)
    }),
  )

  it.live("setPrimary swaps redirects", () =>
    Effect.gen(function* () {
      const domains = yield* PublishDomains.Service
      yield* site("prj_swap", "swap-app")
      yield* domains.add("prj_swap", "one.swap.edu")
      yield* domains.add("prj_swap", "two.swap.edu")
      activate("one.swap.edu")
      activate("two.swap.edu")
      yield* domains.check("prj_swap")
      expect(kv("two.swap.edu")).toBe(JSON.stringify({ redirect: "one.swap.edu" }))

      const result = yield* domains.setPrimary("prj_swap", "two.swap.edu")

      expect(result.domains.find((domain) => domain.primary)?.hostname).toBe("two.swap.edu")
      expect(result.domains.filter((domain) => domain.primary)).toHaveLength(1)
      expect(kv("one.swap.edu")).toBe(JSON.stringify({ redirect: "two.swap.edu" }))
      expect(kv("two.swap.edu")).toBe(JSON.stringify({ script: "swap-app" }))
      expect(kv("swap-app.omai.test")).toBe(JSON.stringify({ redirect: "two.swap.edu" }))
    }),
  )

  it.live("adding with primary: true takes over as primary", () =>
    Effect.gen(function* () {
      const domains = yield* PublishDomains.Service
      yield* site("prj_take", "take-app")
      yield* domains.add("prj_take", "take.edu")
      const result = yield* domains.add("prj_take", "www.take.edu", true)

      expect(result.domains.filter((domain) => domain.primary).map((domain) => domain.hostname)).toEqual([
        "www.take.edu",
      ])
    }),
  )

  it.live("removing the primary promotes the oldest active domain", () =>
    Effect.gen(function* () {
      const domains = yield* PublishDomains.Service
      yield* site("prj_promote", "promote-app")
      yield* domains.add("prj_promote", "a.promote.edu")
      yield* domains.add("prj_promote", "b.promote.edu")
      yield* domains.add("prj_promote", "c.promote.edu")
      yield* domains.add("prj_promote", "d.promote.edu")
      activate("a.promote.edu")
      activate("c.promote.edu")
      activate("d.promote.edu")
      yield* domains.check("prj_promote")

      const result = yield* domains.remove("prj_promote", "a.promote.edu")

      expect(result.domains.map((domain) => domain.hostname)).toEqual([
        "b.promote.edu",
        "c.promote.edu",
        "d.promote.edu",
      ])
      expect(result.domains.find((domain) => domain.primary)?.hostname).toBe("c.promote.edu")
      expect(fake.state.hostnames.has("a.promote.edu")).toBe(false)
      expect(kv("a.promote.edu")).toBeUndefined()
      expect(kv("c.promote.edu")).toBe(JSON.stringify({ script: "promote-app" }))
      expect(kv("b.promote.edu")).toBe(JSON.stringify({ redirect: "c.promote.edu" }))
      expect(kv("promote-app.omai.test")).toBe(JSON.stringify({ redirect: "c.promote.edu" }))

      // With no active domain left the oldest one is promoted, and the subdomain no longer redirects.
      yield* domains.remove("prj_promote", "c.promote.edu")
      const after = yield* domains.remove("prj_promote", "d.promote.edu")
      expect(after.domains.map((domain) => [domain.hostname, domain.primary])).toEqual([["b.promote.edu", true]])
      expect(kv("b.promote.edu")).toBe(JSON.stringify({ script: "promote-app" }))
      expect(kv("promote-app.omai.test")).toBeUndefined()
    }),
  )

  it.live("a hostname already in Cloudflare but not ours is refused", () =>
    Effect.gen(function* () {
      const domains = yield* PublishDomains.Service
      yield* site("prj_taken", "taken-app")
      yield* site("prj_taken_other", "taken-other")
      fake.state.hostnames.set("legacy.edu", {
        id: "ch-legacy",
        hostname: "legacy.edu",
        status: "active",
        ssl: { status: "active" },
      })
      fake.state.kv.set("legacy.edu", "old-project-site")

      const legacy = failureOf(yield* domains.add("prj_taken", "legacy.edu").pipe(Effect.exit))
      expect(legacy?.kind).toBe("taken")
      expect(legacy?.message).toContain("connected to another app")
      expect(fake.state.hostnames.get("legacy.edu")?.id).toBe("ch-legacy")
      expect(kv("legacy.edu")).toBe("old-project-site")

      yield* domains.add("prj_taken_other", "mine.taken.edu")
      const ours = failureOf(yield* domains.add("prj_taken", "mine.taken.edu").pipe(Effect.exit))
      expect(ours?.kind).toBe("taken")
      expect((yield* domains.list("prj_taken")).domains).toEqual([])
    }),
  )

  it.live("invalid, in-zone, unpublished and over-limit domains are refused", () =>
    Effect.gen(function* () {
      const domains = yield* PublishDomains.Service
      const unpublished = failureOf(yield* domains.add("prj_none", "none.edu").pipe(Effect.exit))
      expect(unpublished?.kind).toBe("not-published")

      yield* site("prj_rules", "rules-app")
      expect(failureOf(yield* domains.add("prj_rules", "not a host").pipe(Effect.exit))?.kind).toBe("invalid")
      expect(failureOf(yield* domains.add("prj_rules", "other.omai.test").pipe(Effect.exit))?.kind).toBe("invalid")
      expect(failureOf(yield* domains.add("prj_rules", "omai.test").pipe(Effect.exit))?.kind).toBe("invalid")

      for (const index of Array.from({ length: 10 }, (_, item) => item))
        yield* domains.add("prj_rules", `d${index}.rules.edu`)
      const limit = failureOf(yield* domains.add("prj_rules", "d10.rules.edu").pipe(Effect.exit))
      expect(limit?.kind).toBe("limit")
      expect(fake.state.hostnames.has("d10.rules.edu")).toBe(false)
    }),
  )

  it.live("custom domains not enabled on the zone fail with a plain reason", () =>
    Effect.gen(function* () {
      const domains = yield* PublishDomains.Service
      yield* site("prj_saas", "saas-app")
      fake.state.failing = { status: 403, code: 1456 }
      const exit = yield* domains
        .add("prj_saas", "saas.edu")
        .pipe(Effect.exit, Effect.ensuring(Effect.sync(() => (fake.state.failing = undefined))))
      const failure = failureOf(exit)
      expect(failure?.kind).toBe("cloudflare")
      expect(failure?.message).toBe("Custom domains aren't enabled for this zone yet.")
      expect((yield* domains.list("prj_saas")).domains).toEqual([])
    }),
  )

  it.live("apex records use ALIAS unless apex IPs are configured", () =>
    Effect.gen(function* () {
      const domains = yield* PublishDomains.Service
      yield* site("prj_apex", "apex-app")
      dns.set("domains.omai.test", { cname: [], a: ["192.0.2.1"] })
      dns.set("apex.edu", { cname: [], a: ["192.0.2.1"] })
      const alias = yield* domains.add("prj_apex", "apex.edu")

      expect(alias.domains[0]?.apex).toBe(true)
      expect(alias.domains[0]?.records).toEqual([
        { type: "ALIAS", name: "apex.edu", value: "domains.omai.test", ok: true },
      ])

      process.env.OMAI_CLOUDFLARE_APEX_IPS = "192.0.2.10, 192.0.2.11"
      dns.set("apex.edu", { cname: [], a: ["192.0.2.10"] })
      const ips = yield* domains
        .list("prj_apex")
        .pipe(Effect.ensuring(Effect.sync(() => delete process.env.OMAI_CLOUDFLARE_APEX_IPS)))
      expect(ips.domains[0]?.records).toEqual([
        { type: "A", name: "apex.edu", value: "192.0.2.10", ok: true },
        { type: "A", name: "apex.edu", value: "192.0.2.11", ok: false },
      ])
    }),
  )

  it.live("check is throttled to one Cloudflare read per 10 s", () =>
    Effect.gen(function* () {
      const domains = yield* PublishDomains.Service
      const db = (yield* Database.Service).db
      yield* site("prj_throttle", "throttle-app")
      yield* domains.add("prj_throttle", "throttle.edu")

      const before = hostnameReads()
      yield* domains.check("prj_throttle", "throttle.edu")
      yield* domains.check("prj_throttle", "throttle.edu")
      yield* domains.check("prj_throttle")
      expect(hostnameReads() - before).toBe(1)

      yield* db
        .update(PublishDomainTable)
        .set({ time_checked: Date.now() - 10_001 })
        .where(eq(PublishDomainTable.hostname, "throttle.edu"))
        .run()
        .pipe(Effect.orDie)
      yield* domains.check("prj_throttle", "throttle.edu")
      expect(hostnameReads() - before).toBe(2)
    }),
  )

  it.live("never deletes a KV key for a host not in our DB", () =>
    Effect.gen(function* () {
      const domains = yield* PublishDomains.Service
      yield* site("prj_safe", "safe-app")
      fake.state.kv.set("other.edu", "old-project-site")
      fake.state.hostnames.set("other.edu", {
        id: "ch-other",
        hostname: "other.edu",
        status: "active",
        ssl: { status: "active" },
      })

      yield* domains.add("prj_safe", "www.safe.edu")
      yield* domains.add("prj_safe", "safe.edu")
      activate("www.safe.edu")
      yield* domains.check("prj_safe")
      yield* domains.setPrimary("prj_safe", "safe.edu")
      yield* domains.remove("prj_safe", "www.safe.edu")
      yield* domains.remove("prj_safe", "safe.edu")
      expect(failureOf(yield* domains.remove("prj_safe", "other.edu").pipe(Effect.exit))?.kind).toBe("invalid")

      expect(kv("other.edu")).toBe("old-project-site")
      expect(fake.state.hostnames.get("other.edu")?.id).toBe("ch-other")
      expect(kv("safe.edu")).toBeUndefined()
      expect(kv("www.safe.edu")).toBeUndefined()
      expect(kv("safe-app.omai.test")).toBeUndefined()
    }),
  )

  it.live("a failed KV write is repaired by the next change the user makes", () =>
    Effect.gen(function* () {
      const domains = yield* PublishDomains.Service
      yield* site("prj_repair", "repair-app")
      yield* domains.add("prj_repair", "www.repair.edu")
      yield* domains.add("prj_repair", "repair.edu")
      activate("www.repair.edu")

      fake.state.failingKv = true
      const failed = yield* domains
        .check("prj_repair")
        .pipe(Effect.exit, Effect.ensuring(Effect.sync(() => (fake.state.failingKv = false))))
      expect(failureOf(failed)?.kind).toBe("cloudflare")
      expect(kv("repair.edu")).toBe(JSON.stringify({ script: "repair-app" }))

      // The status change is already stored, so nothing differs between the rows before and after this one; a user's
      // change puts every route again.
      yield* domains.setPrimary("prj_repair", "www.repair.edu")
      expect(kv("repair.edu")).toBe(JSON.stringify({ redirect: "www.repair.edu" }))
      expect(kv("repair-app.omai.test")).toBe(JSON.stringify({ redirect: "www.repair.edu" }))
    }),
  )

  it.live("a check that changes no status writes nothing to KV", () =>
    Effect.gen(function* () {
      const domains = yield* PublishDomains.Service
      const db = (yield* Database.Service).db
      yield* site("prj_quiet", "quiet-app")
      yield* domains.add("prj_quiet", "www.quiet.edu")
      yield* domains.add("prj_quiet", "quiet.edu")
      yield* db
        .update(PublishDomainTable)
        .set({ time_checked: Date.now() - 10_001 })
        .where(eq(PublishDomainTable.project_id, "prj_quiet"))
        .run()
        .pipe(Effect.orDie)

      const reads = hostnameReads()
      const writes = kvWrites()
      yield* domains.check("prj_quiet")
      expect(hostnameReads() - reads).toBe(2)
      expect(kvWrites() - writes).toBe(0)
    }),
  )

  it.live("a check of every domain skips active ones read in the last five minutes", () =>
    Effect.gen(function* () {
      const domains = yield* PublishDomains.Service
      const db = (yield* Database.Service).db
      yield* site("prj_skip", "skip-app")
      yield* domains.add("prj_skip", "www.skip.edu")
      yield* domains.add("prj_skip", "skip.edu")
      activate("www.skip.edu")
      yield* domains.check("prj_skip")
      const age = (ms: number) =>
        db
          .update(PublishDomainTable)
          .set({ time_checked: Date.now() - ms })
          .where(eq(PublishDomainTable.project_id, "prj_skip"))
          .run()
          .pipe(Effect.orDie)

      yield* age(10_001)
      const before = hostnameReads()
      yield* domains.check("prj_skip")
      expect(hostnameReads() - before).toBe(1)
      // Asked for by name, an active domain is read again.
      yield* age(10_001)
      yield* domains.check("prj_skip", "www.skip.edu")
      expect(hostnameReads() - before).toBe(2)

      yield* age(PublishDomains.ACTIVE_CHECK_INTERVAL)
      yield* domains.check("prj_skip")
      expect(hostnameReads() - before).toBe(4)
    }),
  )

  it.live("one hostname failing to load does not stop the check", () =>
    Effect.gen(function* () {
      const domains = yield* PublishDomains.Service
      yield* site("prj_partial", "partial-app")
      yield* domains.add("prj_partial", "www.partial.edu")
      yield* domains.add("prj_partial", "partial.edu")
      activate("www.partial.edu")

      fake.state.failingHostnames.add("partial.edu")
      const result = yield* domains
        .check("prj_partial")
        .pipe(Effect.ensuring(Effect.sync(() => fake.state.failingHostnames.delete("partial.edu"))))

      expect(result.domains.find((domain) => domain.hostname === "www.partial.edu")?.status).toBe("active")
      expect(result.domains.find((domain) => domain.hostname === "partial.edu")?.error).toBe("Internal error")
      expect(kv("partial.edu")).toBe(JSON.stringify({ redirect: "www.partial.edu" }))

      // The failed row was not marked as checked, so the next check reads it again and clears the error.
      const next = yield* domains.check("prj_partial")
      expect(next.domains.find((domain) => domain.hostname === "partial.edu")?.error).toBeUndefined()
    }),
  )

  it.live("changes streams the domains after each change", () =>
    Effect.gen(function* () {
      const domains = yield* PublishDomains.Service
      yield* site("prj_changes", "changes-app")
      const fiber = yield* domains
        .changes("prj_changes")
        .pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped({ startImmediately: true }))
      yield* domains.add("prj_changes", "changes.edu")
      const seen = yield* Fiber.join(fiber)
      expect(seen.map((item) => item.domains.map((domain) => domain.hostname))).toEqual([["changes.edu"]])
    }),
  )
})
