export * as PublishDomains from "./domains.js"

import { asc, eq, sql } from "drizzle-orm"
import { Context, Effect, Layer, PubSub, Schema, Semaphore, Stream } from "effect"
import { Publish } from "@opencode/schema/publish"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { Database } from "../database/database.js"
import { Cloudflare, CloudflareError } from "./cloudflare.js"
import { PublishConfig } from "./config.js"
import { isApex, isHostname, normalizeHostname } from "./name.js"
import { PublishDns } from "./dns.js"
import { PublishRemote } from "./remote.js"
import { PublishRouting } from "./routing.js"
import { PublishError } from "./service.js"
import { PublishDomainTable, PublishSiteTable } from "./sql.js"

export { PublishError } from "./service.js"

/** Domains per site. */
export const LIMIT = 10
/** Cloudflare status reads per hostname are at most this often. */
export const CHECK_INTERVAL = 10_000
/**
 * A check of every domain reads an active one again only this often. The panel checks every 30 s while a domain is
 * pending, and active domains only need an occasional read to notice one removed on Cloudflare.
 */
export const ACTIVE_CHECK_INTERVAL = 300_000

export interface Interface {
  readonly list: (projectID: string) => Effect.Effect<Publish.Domains>
  /** Connects a custom hostname. The first domain, or one added with `primary`, becomes the primary. */
  readonly add: (projectID: string, hostname: string, primary?: boolean) => Effect.Effect<Publish.Domains, PublishError>
  /** Disconnects a domain; removing the primary promotes the oldest active domain, else the oldest. */
  readonly remove: (projectID: string, hostname: string) => Effect.Effect<Publish.Domains, PublishError>
  readonly setPrimary: (projectID: string, hostname: string) => Effect.Effect<Publish.Domains, PublishError>
  /**
   * Refreshes the Cloudflare status of one domain, or of every domain that is not active plus active ones not read for
   * `ACTIVE_CHECK_INTERVAL`. Writes only the KV routes the new statuses change.
   */
  readonly check: (projectID: string, hostname?: string) => Effect.Effect<Publish.Domains, PublishError>
  /** The project's domains after every change. */
  readonly changes: (projectID: string) => Stream.Stream<Publish.Domains>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/PublishDomains") {}

type Row = typeof PublishDomainTable.$inferSelect
type Site = typeof PublishSiteTable.$inferSelect
type Target = { config: PublishConfig.Config; site: Site; rows: Row[] }

export const layerWith = (resolve: PublishDns.Resolve) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      // A change on a VM carries the control plane's answer; a local one is read again.
      const changed = yield* PubSub.unbounded<{ projectID: string; domains?: Publish.Domains }>()
      // A change removes keys by diffing the rows before it against the rows after it, so a project's changes run
      // one at a time. Different projects never share keys and run concurrently.
      const locks = new Map<string, Semaphore.Semaphore>()
      const lockOf = (projectID: string) => {
        const existing = locks.get(projectID)
        if (existing) return existing
        const created = Semaphore.makeUnsafe(1)
        locks.set(projectID, created)
        return created
      }

      const siteOf = (projectID: string) =>
        db.select().from(PublishSiteTable).where(eq(PublishSiteTable.project_id, projectID)).get().pipe(Effect.orDie)

      // Oldest first; rowid breaks ties between domains added in the same millisecond.
      const rowsOf = (projectID: string) =>
        db
          .select()
          .from(PublishDomainTable)
          .where(eq(PublishDomainTable.project_id, projectID))
          .orderBy(asc(PublishDomainTable.time_created), asc(sql`rowid`))
          .all()
          .pipe(Effect.orDie)

      const view = Effect.fnUntraced(function* (projectID: string) {
        const config = PublishConfig.read()
        if (!config) return { configured: false, domains: [] } satisfies Publish.Domains
        const site = yield* siteOf(projectID)
        if (!site?.time_published) return { configured: true, domains: [] } satisfies Publish.Domains
        const rows = yield* rowsOf(projectID)
        const primary = rows.find((row) => row.is_primary)
        const found = yield* Effect.promise(() =>
          PublishDns.recordsOf(
            resolve,
            config,
            rows.map((row) => ({ hostname: row.hostname, ownership: ownershipOf(row) })),
          ),
        )
        const domains = rows.map((row, index) => toDomain(row, found[index] ?? []))
        return {
          configured: true,
          site: {
            name: site.name,
            url: `https://${site.name}.${config.zone}`,
            zone: config.zone,
            ...(site.kind ? { kind: decodeKind(site.kind) } : {}),
            publishedAt: site.time_published,
            ...(primary ? { primary: primary.hostname } : {}),
          },
          subdomain: { host: `${site.name}.${config.zone}`, redirects: primary?.status === "active" },
          domains,
        } satisfies Publish.Domains
      })

      const target = Effect.fnUntraced(function* (projectID: string) {
        const config = PublishConfig.read()
        if (!config) return yield* fail("not-configured", "Publishing isn't set up on this server.")
        const site = yield* siteOf(projectID)
        if (!site?.time_published) return yield* fail("not-published", "Publish the site before adding domains.")
        return { config, site, rows: yield* rowsOf(projectID) } satisfies Target
      })

      /**
       * Runs a change, then writes the routes of the rows after it to KV. A user's change puts every route again (at
       * most 12 keys), so a write lost to an earlier failure is repaired by the next one; a `check`, which runs on a
       * timer, writes only the routes that differ, so it costs no KV writes while nothing changed. Removals always come
       * from the diff against the rows before it. The view is built after the permit is released.
       */
      const change = (
        projectID: string,
        work: (target: Target) => Effect.Effect<void, PublishError>,
        writes: "all" | "diff" = "all",
      ) =>
        Effect.gen(function* () {
          const before = yield* target(projectID)
          yield* work(before)
          const rows = yield* rowsOf(projectID)
          const name = before.site.name
          const zone = before.config.zone
          const next = PublishRouting.routes({ name, zone, domains: rows.map(routeInput) })
          const diff = PublishRouting.diff(
            PublishRouting.routes({ name, zone, domains: before.rows.map(routeInput) }),
            next,
          )
          const put = writes === "all" ? [...next] : diff.put
          const cf = Cloudflare.client(before.config)
          // Only hosts from our rows and this site's subdomain are written or removed, so no other key is touched.
          yield* cloudflare(() =>
            Promise.all([
              ...put.map((entry) => cf.kvPut(entry[0], PublishRouting.serialize(entry[1]))),
              ...diff.remove.map((host) => cf.kvDelete(host)),
            ]),
          )
        }).pipe(
          Semaphore.withPermit(lockOf(projectID)),
          Effect.ensuring(PubSub.publish(changed, { projectID })),
          Effect.andThen(view(projectID)),
        )

      const makePrimary = (hostname: string, projectID: string) =>
        db
          .update(PublishDomainTable)
          .set({ is_primary: eq(PublishDomainTable.hostname, hostname), time_updated: Date.now() })
          .where(eq(PublishDomainTable.project_id, projectID))
          .run()
          .pipe(Effect.orDie)

      const add: Interface["add"] = (projectID, input, primary) =>
        change(
          projectID,
          Effect.fnUntraced(function* (target) {
            const host = normalizeHostname(input)
            const zone = target.config.zone
            if (!isHostname(host)) return yield* fail("invalid", "Enter a domain like www.example.com.")
            if (host === zone || host.endsWith(`.${zone}`))
              return yield* fail("invalid", `Addresses on ${zone} can't be added. Use a domain you own.`)
            const existing = yield* db
              .select()
              .from(PublishDomainTable)
              .where(eq(PublishDomainTable.hostname, host))
              .get()
              .pipe(Effect.orDie)
            if (existing && existing.project_id !== projectID)
              return yield* fail("taken", "This domain is already connected to another site.")
            if (existing) return primary ? yield* makePrimary(host, projectID) : undefined
            if (target.rows.length >= LIMIT) return yield* fail("limit", `A site can have up to ${LIMIT} domains.`)

            const cf = Cloudflare.client(target.config)
            if (yield* cloudflare(() => cf.getHostname(host)))
              return yield* fail("taken", "This domain is connected to another app. Disconnect it there first.")
            const now = Date.now()
            // Our row claims the hostname before Cloudflare does; it goes again if Cloudflare refuses.
            yield* db
              .insert(PublishDomainTable)
              .values({
                hostname: host,
                project_id: projectID,
                is_primary: false,
                status: "pending",
                ssl: "pending",
                time_created: now,
                time_updated: now,
              })
              .run()
              .pipe(
                Effect.mapError(
                  () =>
                    new PublishError({ kind: "taken", message: "This domain is already connected to another site." }),
                ),
              )
            const created = yield* cloudflare(() => cf.addHostname(host)).pipe(
              Effect.tapError(() =>
                db.delete(PublishDomainTable).where(eq(PublishDomainTable.hostname, host)).run().pipe(Effect.orDie),
              ),
            )
            yield* db
              .update(PublishDomainTable)
              .set({
                cf_id: created.id,
                status: Cloudflare.hostnameStatus(created),
                ssl: created.ssl.status,
                verification: created.ownership ? JSON.stringify(created.ownership) : null,
              })
              .where(eq(PublishDomainTable.hostname, host))
              .run()
              .pipe(Effect.orDie)
            if (primary || !target.rows.some((row) => row.is_primary)) yield* makePrimary(host, projectID)
          }),
        )

      const remove: Interface["remove"] = (projectID, input) =>
        change(
          projectID,
          Effect.fnUntraced(function* (target) {
            const row = yield* own(target, input)
            const cf = Cloudflare.client(target.config)
            // Without a recorded id the hostname was never ours to delete.
            const id = row.cf_id
            if (id) yield* cloudflare(() => cf.deleteHostname(id))
            yield* db
              .delete(PublishDomainTable)
              .where(eq(PublishDomainTable.hostname, row.hostname))
              .run()
              .pipe(Effect.orDie)
            if (!row.is_primary) return
            const rest = target.rows.filter((item) => item.hostname !== row.hostname)
            const next = rest.find((item) => item.status === "active") ?? rest[0]
            if (next) yield* makePrimary(next.hostname, projectID)
          }),
        )

      const setPrimary: Interface["setPrimary"] = (projectID, input) =>
        change(
          projectID,
          Effect.fnUntraced(function* (target) {
            yield* makePrimary((yield* own(target, input)).hostname, projectID)
          }),
        )

      const check: Interface["check"] = (projectID, input) =>
        change(
          projectID,
          Effect.fnUntraced(function* (target) {
            const now = Date.now()
            const rows =
              input === undefined
                ? target.rows.filter((row) => row.status !== "active" || due(row, now, ACTIVE_CHECK_INTERVAL))
                : [yield* own(target, input)]
            const cf = Cloudflare.client(target.config)
            yield* Effect.forEach(
              rows.filter((row) => due(row, now, CHECK_INTERVAL)),
              (row) =>
                Effect.gen(function* () {
                  const read = yield* Effect.result(cloudflare(() => cf.getHostname(row.hostname)))
                  // A failed read is recorded on its row and stops neither the other rows nor the KV write. The row
                  // keeps its old time_checked, so the next check reads it again.
                  if (read._tag === "Failure")
                    return yield* db
                      .update(PublishDomainTable)
                      .set({ error: read.failure.message })
                      .where(eq(PublishDomainTable.hostname, row.hostname))
                      .run()
                      .pipe(Effect.orDie)
                  const found = read.success
                  // A hostname with another id was created by someone else after ours went away.
                  const ours = found && found.id === row.cf_id ? found : undefined
                  yield* db
                    .update(PublishDomainTable)
                    .set(
                      ours
                        ? {
                            status: Cloudflare.hostnameStatus(ours),
                            ssl: ours.ssl.status,
                            ...(ours.ownership ? { verification: JSON.stringify(ours.ownership) } : {}),
                            error: null,
                            time_checked: now,
                          }
                        : {
                            status: "error",
                            error: "This domain is no longer connected on Cloudflare. Remove it and add it again.",
                            time_checked: now,
                          },
                    )
                    .where(eq(PublishDomainTable.hostname, row.hostname))
                    .run()
                    .pipe(Effect.orDie)
                }),
              { concurrency: "unbounded", discard: true },
            )
          }),
          "diff",
        )

      // On a project's MicroVM the control plane owns the domains and does every Cloudflare call.
      const remote = () => {
        const target = PublishRemote.target(process.env)
        return target ? PublishRemote.client(target).domains : undefined
      }
      const forwarded = (projectID: string, work: () => Promise<Publish.Domains>, changes = true) =>
        Effect.tryPromise({
          try: work,
          catch: (error) =>
            error instanceof PublishRemote.RemoteError
              ? new PublishError({ kind: error.kind, message: error.message })
              : new PublishError({ kind: "other", message: error instanceof Error ? error.message : "The request failed." }),
        }).pipe(Effect.tap((domains) => (changes ? PubSub.publish(changed, { projectID, domains }) : Effect.void)))

      return Service.of({
        list: (projectID) => {
          const client = remote()
          // A list the control plane can't answer shows no domains rather than failing the panel.
          if (client)
            return forwarded(projectID, () => client.list(), false).pipe(
              Effect.catch(() => Effect.succeed({ configured: true, domains: [] } satisfies Publish.Domains)),
            )
          return view(projectID)
        },
        add: (projectID, hostname, primary) => {
          const client = remote()
          return client ? forwarded(projectID, () => client.add(hostname, primary)) : add(projectID, hostname, primary)
        },
        remove: (projectID, hostname) => {
          const client = remote()
          return client ? forwarded(projectID, () => client.remove(hostname)) : remove(projectID, hostname)
        },
        setPrimary: (projectID, hostname) => {
          const client = remote()
          return client ? forwarded(projectID, () => client.setPrimary(hostname)) : setPrimary(projectID, hostname)
        },
        check: (projectID, hostname) => {
          const client = remote()
          return client ? forwarded(projectID, () => client.check(hostname)) : check(projectID, hostname)
        },
        changes: (projectID) =>
          Stream.fromPubSub(changed).pipe(
            Stream.filter((item) => item.projectID === projectID),
            Stream.mapEffect((item) => (item.domains ? Effect.succeed(item.domains) : view(projectID))),
          ),
      })
    }),
  )

export const layer = layerWith(PublishDns.lookup)

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node] })

const decodeKind = Schema.decodeUnknownSync(Publish.Kind)
const decodeStatus = Schema.decodeUnknownSync(Publish.DomainStatus)
const decodeOwnership = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ name: Schema.String, value: Schema.String })),
)
const SAAS_DISABLED: ReadonlySet<number> = new Set([1404, 1456])

function ownershipOf(row: Row) {
  const decoded = row.verification ? decodeOwnership(row.verification) : undefined
  return decoded?._tag === "Some" ? decoded.value : undefined
}

function toDomain(row: Row, dns: Publish.DnsRecord[]): Publish.Domain {
  const ownership = ownershipOf(row)
  return {
    hostname: row.hostname,
    primary: row.is_primary,
    status: decodeStatus(row.status),
    ssl: row.ssl,
    apex: isApex(row.hostname),
    records: dns,
    ...(ownership ? { verification: { type: "TXT", name: ownership.name, value: ownership.value } } : {}),
    ...(row.error ? { error: row.error } : {}),
  }
}

function due(row: Row, now: number, interval: number) {
  return row.time_checked === null || now - row.time_checked >= interval
}

function routeInput(row: Row) {
  return { hostname: row.hostname, primary: row.is_primary, status: row.status }
}

/** This project's row for the hostname. */
function own(target: Target, input: string) {
  const host = normalizeHostname(input)
  const row = target.rows.find((item) => item.hostname === host)
  if (row) return Effect.succeed(row)
  return fail("invalid", "This domain isn't connected to this site.")
}

function fail(kind: Publish.FailureKind, message: string) {
  return Effect.fail(new PublishError({ kind, message }))
}

/** Runs Cloudflare calls, reporting Cloudflare's own message and nothing from the raw response. */
function cloudflare<A>(work: () => Promise<A>) {
  return Effect.tryPromise({
    try: work,
    catch: (error) =>
      new PublishError({
        kind: "cloudflare",
        message:
          error instanceof CloudflareError && error.codes.some((code) => SAAS_DISABLED.has(code))
            ? "Custom domains aren't enabled for this zone yet."
            : error instanceof Error
              ? error.message
              : "Cloudflare failed.",
      }),
  })
}
