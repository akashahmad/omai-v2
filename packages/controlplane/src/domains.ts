export * as Domains from "./domains.js"

import { randomUUID } from "node:crypto"
import { and, asc, eq, isNull } from "drizzle-orm"
import { Schema } from "effect"
import { Publish } from "@opencode/schema/publish"
import { Cloudflare, CloudflareError } from "@opencode/core/publish/cloudflare"
import { PublishConfig } from "@opencode/core/publish/config"
import { PublishDns } from "@opencode/core/publish/dns"
import { isApex, isHostname, normalizeHostname } from "@opencode/core/publish/name"
import { PublishRouting } from "@opencode/core/publish/routing"
import type { Config } from "./config.js"
import type { Db } from "./db/database.js"
import { Locks } from "./locks.js"
import { PublishedDomainTable, PublishedSiteTable } from "./db/schema.js"
import { Refusal } from "./publishing.js"

/** Domains per site. */
export const LIMIT = 10
/** Cloudflare status reads per hostname are at most this often. */
export const CHECK_INTERVAL = 10_000
/** A check of every domain reads an active one again only this often. */
export const ACTIVE_CHECK_INTERVAL = 300_000

type Row = typeof PublishedDomainTable.$inferSelect
type Site = typeof PublishedSiteTable.$inferSelect
type Target = { config: PublishConfig.Config; site: Site; rows: Row[] }

/**
 * Custom hostnames of each project's site, owned here. The same rules as single-user domains
 * (`core/src/publish/domains.ts`): only hosts from our rows and the site's own subdomain are written to KV, and a
 * custom hostname is deleted only by its recorded id.
 */
export function make(deps: {
  db: Db
  config: Pick<Config, "cloudflare">
  locks?: Locks
  resolve?: PublishDns.Resolve
  now?: () => number
}) {
  const db = deps.db
  const resolve = deps.resolve ?? PublishDns.lookup
  const now = deps.now ?? Date.now
  // A change removes keys by diffing the rows before it against the rows after it, so a project's changes run one
  // at a time, in the same queue as the site's removal.
  const serial = (deps.locks ?? Locks.make()).serial
  const siteOf = async (projectID: string) =>
    (
      await db
        .select()
        .from(PublishedSiteTable)
        .where(and(eq(PublishedSiteTable.project_id, projectID), isNull(PublishedSiteTable.deleted_at)))
    )[0]

  // Oldest first; the id breaks ties between domains added in the same millisecond only loosely, which is fine for
  // ordering a list.
  const rowsOf = (projectID: string) =>
    db
      .select()
      .from(PublishedDomainTable)
      .where(and(eq(PublishedDomainTable.project_id, projectID), isNull(PublishedDomainTable.deleted_at)))
      .orderBy(asc(PublishedDomainTable.created_at), asc(PublishedDomainTable.id))

  const list = async (projectID: string): Promise<Publish.Domains> => {
    const config = deps.config.cloudflare
    if (!config) return { configured: false, domains: [] }
    const site = await siteOf(projectID)
    if (!site?.published_at) return { configured: true, domains: [] }
    const rows = await rowsOf(projectID)
    const primary = rows.find((row) => row.is_primary)
    const found = await PublishDns.recordsOf(
      resolve,
      config,
      rows.map((row) => ({ hostname: row.hostname, ownership: ownershipOf(row) })),
    )
    return {
      configured: true,
      site: {
        name: site.name,
        url: `https://${site.name}.${config.zone}`,
        zone: config.zone,
        ...(site.kind ? { kind: decodeKind(site.kind) } : {}),
        publishedAt: site.published_at.getTime(),
        ...(primary ? { primary: primary.hostname } : {}),
      },
      subdomain: { host: `${site.name}.${config.zone}`, redirects: primary?.status === "active" },
      domains: rows.map((row, index) => toDomain(row, found[index] ?? [])),
    }
  }

  const target = async (projectID: string): Promise<Target> => {
    const config = deps.config.cloudflare
    if (!config) throw new Refusal("not-configured", "Publishing isn't set up on this server.")
    const site = await siteOf(projectID)
    if (!site?.published_at) throw new Refusal("not-published", "Publish the site before adding domains.")
    return { config, site, rows: await rowsOf(projectID) }
  }

  /**
   * Runs a change, then writes the routes of the rows after it to KV: every route after a user's change (so a lost
   * write is repaired), only the changed ones after a `check`. Removals always come from the diff.
   */
  const change = async (projectID: string, work: (target: Target) => Promise<void>, writes: "all" | "diff" = "all") => {
    await serial(projectID, async () => {
      const before = await target(projectID)
      await work(before)
      const rows = await rowsOf(projectID)
      const name = before.site.name
      const zone = before.config.zone
      const next = PublishRouting.routes({ name, zone, domains: rows.map(routeInput) })
      const diff = PublishRouting.diff(
        PublishRouting.routes({ name, zone, domains: before.rows.map(routeInput) }),
        next,
      )
      const put = writes === "all" ? [...next] : diff.put
      const cf = Cloudflare.client(before.config)
      await cloudflare(() =>
        Promise.all([
          ...put.map((entry) => cf.kvPut(entry[0], PublishRouting.serialize(entry[1]))),
          ...diff.remove.map((host) => cf.kvDelete(host)),
        ]),
      )
    })
    return list(projectID)
  }

  const makePrimary = async (projectID: string, hostname: string) => {
    const rows = await rowsOf(projectID)
    await Promise.all(
      rows.map((row) =>
        db
          .update(PublishedDomainTable)
          .set({ is_primary: row.hostname === hostname, updated_at: new Date(now()) })
          .where(eq(PublishedDomainTable.id, row.id)),
      ),
    )
  }

  return {
    list,

    /** Connects a custom hostname. The first domain, or one added with `primary`, becomes the primary. */
    add: (projectID: string, input: string, primary?: boolean) =>
      change(projectID, async (target) => {
        const host = normalizeHostname(input)
        const zone = target.config.zone
        if (!isHostname(host)) throw new Refusal("invalid", "Enter a domain like www.example.com.")
        if (host === zone || host.endsWith(`.${zone}`))
          throw new Refusal("invalid", `Addresses on ${zone} can't be added. Use a domain you own.`)
        const existing = (
          await db
            .select()
            .from(PublishedDomainTable)
            .where(and(eq(PublishedDomainTable.hostname, host), isNull(PublishedDomainTable.deleted_at)))
        )[0]
        if (existing && existing.project_id !== projectID)
          throw new Refusal("taken", "This domain is already connected to another site.")
        if (existing) return primary ? makePrimary(projectID, host) : undefined
        if (target.rows.length >= LIMIT) throw new Refusal("limit", `A site can have up to ${LIMIT} domains.`)

        const cf = Cloudflare.client(target.config)
        if (await cloudflare(() => cf.getHostname(host)))
          throw new Refusal("taken", "This domain is connected to another app. Disconnect it there first.")
        const at = new Date(now())
        const id = randomUUID()
        // Our row claims the hostname before Cloudflare does; it is deleted again if Cloudflare refuses.
        const inserted = await db
          .insert(PublishedDomainTable)
          .values({
            id,
            hostname: host,
            project_id: projectID,
            is_primary: false,
            status: "pending",
            ssl: "pending",
            created_at: at,
            updated_at: at,
          })
          .onConflictDoNothing()
          .returning({ id: PublishedDomainTable.id })
        if (inserted.length === 0) throw new Refusal("taken", "This domain is already connected to another site.")
        const created = await cloudflare(() => cf.addHostname(host)).catch(async (error: unknown) => {
          await db
            .update(PublishedDomainTable)
            .set({ deleted_at: new Date(now()) })
            .where(eq(PublishedDomainTable.id, id))
          throw error
        })
        await db
          .update(PublishedDomainTable)
          .set({
            cf_id: created.id,
            status: Cloudflare.hostnameStatus(created),
            ssl: created.ssl.status,
            verification: created.ownership ? JSON.stringify(created.ownership) : null,
          })
          .where(eq(PublishedDomainTable.id, id))
        if (primary || !target.rows.some((row) => row.is_primary)) await makePrimary(projectID, host)
      }),

    /** Disconnects a domain; removing the primary promotes the oldest active domain, else the oldest. */
    remove: (projectID: string, input: string) =>
      change(projectID, async (target) => {
        const row = own(target, input)
        const cf = Cloudflare.client(target.config)
        // Without a recorded id the hostname was never ours to delete.
        const id = row.cf_id
        if (id) await cloudflare(() => cf.deleteHostname(id))
        await db
          .update(PublishedDomainTable)
          .set({ deleted_at: new Date(now()), updated_at: new Date(now()), is_primary: false })
          .where(eq(PublishedDomainTable.id, row.id))
        if (!row.is_primary) return
        const rest = target.rows.filter((item) => item.id !== row.id)
        const next = rest.find((item) => item.status === "active") ?? rest[0]
        if (next) await makePrimary(projectID, next.hostname)
      }),

    setPrimary: (projectID: string, input: string) =>
      change(projectID, (target) => makePrimary(projectID, own(target, input).hostname)),

    /**
     * Refreshes the Cloudflare status of one domain, or of every domain that is not active plus active ones not read
     * for `ACTIVE_CHECK_INTERVAL`. Writes only the KV routes the new statuses change.
     */
    check: (projectID: string, input?: string) =>
      change(
        projectID,
        async (target) => {
          const at = now()
          const rows =
            input === undefined
              ? target.rows.filter((row) => row.status !== "active" || due(row, at, ACTIVE_CHECK_INTERVAL))
              : [own(target, input)]
          const cf = Cloudflare.client(target.config)
          await Promise.all(
            rows
              .filter((row) => due(row, at, CHECK_INTERVAL))
              .map(async (row) => {
                const read = await cloudflare(() => cf.getHostname(row.hostname)).then(
                  (found) => ({ ok: true as const, found }),
                  (error: Refusal) => ({ ok: false as const, error }),
                )
                // A failed read is recorded on its row and stops neither the other rows nor the KV write. The row
                // keeps its old checked time, so the next check reads it again.
                if (!read.ok)
                  return db
                    .update(PublishedDomainTable)
                    .set({ error: read.error.message })
                    .where(eq(PublishedDomainTable.id, row.id))
                // A hostname with another id was created by someone else after ours went away.
                const ours = read.found && read.found.id === row.cf_id ? read.found : undefined
                return db
                  .update(PublishedDomainTable)
                  .set(
                    ours
                      ? {
                          status: Cloudflare.hostnameStatus(ours),
                          ssl: ours.ssl.status,
                          ...(ours.ownership ? { verification: JSON.stringify(ours.ownership) } : {}),
                          error: null,
                          checked_at: new Date(at),
                        }
                      : {
                          status: "error",
                          error: "This domain is no longer connected on Cloudflare. Remove it and add it again.",
                          checked_at: new Date(at),
                        },
                  )
                  .where(eq(PublishedDomainTable.id, row.id))
              }),
          )
        },
        "diff",
      ),
  }
}

export type Domains = ReturnType<typeof make>

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
  return row.checked_at === null || now - row.checked_at.getTime() >= interval
}

function routeInput(row: Row) {
  return { hostname: row.hostname, primary: row.is_primary, status: row.status }
}

/** This project's row for the hostname. */
function own(target: Target, input: string) {
  const host = normalizeHostname(input)
  const row = target.rows.find((item) => item.hostname === host)
  if (row) return row
  throw new Refusal("invalid", "This domain isn't connected to this site.")
}

/** Runs Cloudflare calls, reporting Cloudflare's own message and nothing from the raw response. */
function cloudflare<A>(work: () => Promise<A>) {
  return work().catch((error: unknown) => {
    throw new Refusal(
      "cloudflare",
      error instanceof CloudflareError && error.codes.some((code) => SAAS_DISABLED.has(code))
        ? "Custom domains aren't enabled for this zone yet."
        : error instanceof Error
          ? error.message
          : "Cloudflare failed.",
    )
  })
}
