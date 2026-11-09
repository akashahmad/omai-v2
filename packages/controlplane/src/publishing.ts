export * as Publishing from "./publishing.js"

import { randomUUID } from "node:crypto"
import { createWriteStream } from "node:fs"
import { access, mkdir, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { Transform } from "node:stream"
import { pipeline } from "node:stream/promises"
import { and, eq, isNull } from "drizzle-orm"
import { Schema } from "effect"
import { Publish } from "@opencode/schema/publish"
import { buildEnv } from "@opencode/core/publish/adapt"
import { Cloudflare } from "@opencode/core/publish/cloudflare"
import { validName } from "@opencode/core/publish/name"
import { deployArgs, ensureWrangler, uploadConfig } from "@opencode/core/publish/wrangler"
import { unzip } from "@opencode/core/project-vm/unzip"
import { LogBuffer, runGroup } from "@opencode/core/preview/process"
import type { Config } from "./config.js"
import type { Db } from "./db/database.js"
import { Locks } from "./locks.js"
import { PublishedDomainTable, PublishedSiteTable } from "./db/schema.js"

export const UPLOAD_TIMEOUT = 300_000
/** How long a deploy waits for a free upload slot by default. */
export const QUEUE_WAIT = 120_000
/** The log kept with a deploy answer. */
export const LOG_TAIL = 64 * 1024

/** A publishing request refused with a plain reason the VM shows as is. */
export class Refusal extends Error {
  constructor(
    readonly kind: Publish.FailureKind,
    message: string,
    readonly log?: string,
  ) {
    super(message)
    this.name = "Refusal"
  }
}

export type SiteView = {
  name: string
  url: string
  zone: string
  kind?: Publish.Kind
  publishedAt?: number
  primary?: string
}

type Deps = {
  db: Db
  config: Pick<Config, "cloudflare" | "dataDir" | "publishMaxBytes" | "publishConcurrency">
  /** Where `ensureWrangler` reads `OMAI_PUBLISH_WRANGLER` (tests point it at a fake). */
  env?: Record<string, string | undefined>
  /** Shared with `Domains`, so a site's removal and its domain changes never interleave. */
  locks?: Locks
  /** How long a deploy may wait for a free upload slot before it is refused as busy. */
  queueWaitMs?: number
}

/**
 * Sites on the shared Cloudflare account, owned here by project. Only scripts, KV keys and custom hostnames our rows
 * name are ever changed, through the same client and rules as single-user publishing.
 */
export function make(deps: Deps) {
  const db = deps.db
  const running = new Set<string>()
  const slots = queue(deps.config.publishConcurrency, deps.queueWaitMs ?? QUEUE_WAIT)
  const locks = deps.locks ?? Locks.make()

  const cloudflare = () => {
    const config = deps.config.cloudflare
    if (!config) throw new Refusal("not-configured", "Publishing isn't set up on this server.")
    return { config, client: Cloudflare.client(config) }
  }

  const siteOf = async (projectID: string) =>
    (
      await db
        .select()
        .from(PublishedSiteTable)
        .where(and(eq(PublishedSiteTable.project_id, projectID), isNull(PublishedSiteTable.deleted_at)))
    )[0]

  const view = async (projectID: string): Promise<SiteView | undefined> => {
    const config = deps.config.cloudflare
    const site = await siteOf(projectID)
    if (!site || !config) return undefined
    const primary = (
      await db
        .select({ hostname: PublishedDomainTable.hostname })
        .from(PublishedDomainTable)
        .where(
          and(
            eq(PublishedDomainTable.project_id, projectID),
            eq(PublishedDomainTable.is_primary, true),
            isNull(PublishedDomainTable.deleted_at),
          ),
        )
    )[0]
    return {
      name: site.name,
      url: `https://${site.name}.${config.zone}`,
      zone: config.zone,
      ...(site.kind ? { kind: decodeKind(site.kind) } : {}),
      ...(site.published_at ? { publishedAt: site.published_at.getTime() } : {}),
      ...(primary ? { primary: primary.hostname } : {}),
    }
  }

  const available = async (projectID: string, name: string) => {
    const cf = cloudflare()
    const invalid = validName(name)
    if (invalid) return { available: false, reason: invalid }
    const owned = (
      await db
        .select({ project_id: PublishedSiteTable.project_id })
        .from(PublishedSiteTable)
        .where(and(eq(PublishedSiteTable.name, name), isNull(PublishedSiteTable.deleted_at)))
    )[0]
    if (owned) return owned.project_id === projectID ? { available: true } : taken
    return guard(async () => {
      if ((await cf.client.scriptExists(name)) && (await cf.client.scriptOwner(name)) !== projectID) return taken
      if (await cf.client.hasRecord(`${name}.${cf.config.zone}`)) return taken
      return { available: true }
    })
  }

  /** Soft-deletes a claimed name that never went live, after removing its placeholder script if it is ours. */
  const releaseClaim = (projectID: string) =>
    locks.serial(projectID, async () => {
      const site = await siteOf(projectID)
      if (!site || site.published_at) return
      const cf = cloudflare()
      await guard(async () => {
        if ((await cf.client.scriptOwner(site.name)) === projectID) await cf.client.deleteScript(site.name)
      })
      await db
        .update(PublishedSiteTable)
        .set({ deleted_at: new Date(), updated_at: new Date() })
        .where(eq(PublishedSiteTable.id, site.id))
    })

  /**
   * The VM's release after its first publish failed. Refused while a deploy runs: that deploy releases the name
   * itself if it fails, and may still go live.
   */
  const release = async (projectID: string) => {
    if (running.has(projectID)) throw new Refusal("busy", "A publish is still uploading for this project.")
    await releaseClaim(projectID)
  }

  return {
    status: async (projectID: string) => {
      const config = deps.config.cloudflare
      const site = await view(projectID)
      return { configured: config !== undefined, ...(config ? { zone: config.zone } : {}), ...(site ? { site } : {}) }
    },

    view,
    available,
    release,

    /** Reserves the name for a first publish: our row first (unique), then the placeholder when no script exists. */
    claim: async (projectID: string, userID: string, name: string) => {
      const cf = cloudflare()
      if (await siteOf(projectID)) return (await view(projectID))!
      const free = await available(projectID, name)
      if (!free.available) throw new Refusal(validName(name) ? "invalid" : "taken", free.reason ?? "")
      const inserted = await db
        .insert(PublishedSiteTable)
        .values({ id: randomUUID(), project_id: projectID, user_id: userID, name })
        .onConflictDoNothing()
        .returning({ id: PublishedSiteTable.id })
      if (inserted.length === 0) throw new Refusal("taken", taken.reason)
      await guard(async () => {
        if (!(await cf.client.scriptExists(name))) await cf.client.claimScript(name, projectID)
      }).catch(async (error: unknown) => {
        await db
          .update(PublishedSiteTable)
          .set({ deleted_at: new Date() })
          .where(eq(PublishedSiteTable.id, inserted[0]!.id))
        throw error
      })
      return (await view(projectID))!
    },

    /**
     * Uploads a VM's bundle (a zip of `assets/` and, for server kinds, `worker/`) as the project's script. The deploy
     * config is generated here from the kind alone, so nothing in the upload reaches other resources. Aborting
     * `signal` stops wrangler. A failed first deploy releases the name.
     */
    deploy: async (
      projectID: string,
      input: { body: AsyncIterable<Buffer>; kind: string; entry?: string; signal: AbortSignal },
    ) => {
      const cf = cloudflare()
      const site = await siteOf(projectID)
      if (!site) throw new Refusal("not-published", "Choose a name for the site.")
      const kind = Schema.decodeUnknownOption(Publish.Kind)(input.kind)
      if (kind._tag === "None") throw new Refusal("invalid", "Unknown site kind.")
      const server = "main" in uploadConfig(kind.value, { name: site.name, root: "/" })
      if (server && !(input.entry && /^[A-Za-z0-9_][A-Za-z0-9_.-]*\.m?js$/.test(input.entry)))
        throw new Refusal("invalid", "The upload names no worker entry.")
      if (running.has(projectID)) throw new Refusal("busy", "A publish is already uploading for this project.")
      running.add(projectID)
      const dir = path.join(deps.config.dataDir, "publish", projectID, randomUUID())
      const log = new LogBuffer()
      try {
        await mkdir(dir, { recursive: true, mode: 0o700 })
        const zip = path.join(dir, "upload.zip")
        if (!(await receive(input.body, zip, deps.config.publishMaxBytes)))
          throw new Refusal(
            "limit",
            `The site is larger than ${Math.round(deps.config.publishMaxBytes / 1024 / 1024)} MB.`,
          )
        const root = path.join(dir, "bundle")
        await mkdir(root)
        await unzip({ zip, directory: root, maxBytes: deps.config.publishMaxBytes * 4 }).catch((error: unknown) => {
          throw new Refusal(
            "invalid",
            `The upload could not be unpacked: ${error instanceof Error ? error.message : String(error)}`,
          )
        })
        await mkdir(path.join(root, "assets"), { recursive: true })
        const generated = uploadConfig(kind.value, { name: site.name, root, entry: input.entry })
        const main = "main" in generated ? generated.main : undefined
        if (main && !(await exists(main))) throw new Refusal("invalid", "The upload is missing its worker entry.")
        const config = path.join(dir, "wrangler.json")
        await writeFile(config, JSON.stringify(generated, null, 2) + "\n")
        const wrangler = await ensureWrangler(path.join(deps.config.dataDir, "publish", "tools"), deps.env).catch(
          (error: unknown) => {
            throw new Refusal("cloudflare", error instanceof Error ? error.message : String(error))
          },
        )
        const args = deployArgs({ name: site.name, namespace: cf.config.namespace, config })
        log.append(`$ wrangler ${args.join(" ")}\n`)
        const code = await slots(() =>
          runGroup({
            command: [wrangler, ...args].map(quote).join(" "),
            cwd: dir,
            // Wrangler's own variable names; only this step gets the credentials.
            env: {
              ...buildEnv(),
              CLOUDFLARE_API_TOKEN: cf.config.token,
              CLOUDFLARE_ACCOUNT_ID: cf.config.accountID,
              WRANGLER_SEND_METRICS: "false",
            },
            timeout: UPLOAD_TIMEOUT,
            signal: input.signal,
            onLog: (chunk) => log.append(chunk),
          }),
        )
        if (input.signal.aborted && code !== 0) throw new Refusal("other", "The publish was cancelled.")
        if (code === "timeout")
          throw new Refusal("cloudflare", `The upload took longer than ${UPLOAD_TIMEOUT / 60_000} minutes.`)
        if (code !== 0)
          throw new Refusal(
            "cloudflare",
            site.published_at
              ? "The upload to Cloudflare failed. The previous version is still live."
              : "The upload to Cloudflare failed. Nothing was published.",
          )
        // Once wrangler exited 0 the version is live, even if the VM went away in the same moment.
        await db
          .update(PublishedSiteTable)
          .set({ kind: kind.value, published_at: new Date(), updated_at: new Date() })
          .where(and(eq(PublishedSiteTable.id, site.id), isNull(PublishedSiteTable.deleted_at)))
        return { log: log.tail(LOG_TAIL) }
      } catch (error) {
        if (!site.published_at)
          await releaseClaim(projectID).catch(() => log.append("\nReleasing the reserved name failed.\n"))
        if (error instanceof Refusal) throw new Refusal(error.kind, error.message, log.tail(LOG_TAIL))
        throw error
      } finally {
        running.delete(projectID)
        await rm(dir, { recursive: true, force: true })
      }
    },

    /** Deletes the site: its KV keys, custom hostnames (by recorded id), script, then soft-deletes the rows. */
    remove: (projectID: string, confirm: string) =>
      locks.serial(projectID, async () => {
        const cf = cloudflare()
        const site = await siteOf(projectID)
        if (!site) throw new Refusal("not-published", "This project has no site.")
        if (confirm !== site.name) throw new Refusal("invalid", `Type ${site.name} to delete the site.`)
        if (running.has(projectID)) throw new Refusal("busy", "A publish is uploading. Try again when it finishes.")
        const domains = await db
          .select()
          .from(PublishedDomainTable)
          .where(and(eq(PublishedDomainTable.project_id, projectID), isNull(PublishedDomainTable.deleted_at)))
        await guard(async () => {
          await Promise.all(
            [...domains.map((domain) => domain.hostname), `${site.name}.${cf.config.zone}`].map((host) =>
              cf.client.kvDelete(host),
            ),
          )
          await Promise.all(domains.flatMap((domain) => (domain.cf_id ? [cf.client.deleteHostname(domain.cf_id)] : [])))
          await cf.client.deleteScript(site.name)
        })
        const now = new Date()
        await db
          .update(PublishedDomainTable)
          .set({ deleted_at: now, updated_at: now })
          .where(and(eq(PublishedDomainTable.project_id, projectID), isNull(PublishedDomainTable.deleted_at)))
        await db
          .update(PublishedSiteTable)
          .set({ deleted_at: now, updated_at: now })
          .where(eq(PublishedSiteTable.id, site.id))
      }),
  }
}

export type Publishing = ReturnType<typeof make>

const taken = { available: false, reason: "This name is taken. Choose another." }
const decodeKind = Schema.decodeUnknownSync(Publish.Kind)

/** Runs Cloudflare calls, reporting Cloudflare's own message and nothing from the raw response. */
export async function guard<A>(work: () => Promise<A>) {
  return work().catch((error: unknown) => {
    if (error instanceof Refusal) throw error
    throw new Refusal("cloudflare", error instanceof Error ? error.message : "Cloudflare failed.")
  })
}

/** Writes the body to `file`; false when it grows past `limit` (the partial file is left for the caller's cleanup). */
async function receive(body: AsyncIterable<Buffer>, file: string, limit: number) {
  const state = { size: 0 }
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      state.size += chunk.length
      if (state.size > limit) return done(new Error("too large"))
      done(null, chunk)
    },
  })
  return pipeline(body, counter, createWriteStream(file, { mode: 0o600 })).then(
    () => true,
    (error: unknown) => {
      if (state.size > limit) return false
      throw error
    },
  )
}

/**
 * Runs at most `size` tasks at once; the rest wait in order, each for at most `wait` ms, after which it is refused as
 * busy so the VM hears a plain reason instead of timing out.
 */
function queue(size: number, wait: number) {
  const state = { active: 0 }
  const waiting: (() => void)[] = []
  return async <A>(task: () => Promise<A>) => {
    if (state.active >= size)
      await new Promise<void>((resolve, reject) => {
        const turn = () => {
          clearTimeout(timer)
          resolve()
        }
        const timer = setTimeout(() => {
          waiting.splice(waiting.indexOf(turn), 1)
          reject(new Refusal("busy", "O M A I + is publishing many sites right now. Try again in a minute."))
        }, wait)
        waiting.push(turn)
      })
    state.active++
    try {
      return await task()
    } finally {
      state.active--
      waiting.shift()?.()
    }
  }
}

const exists = (target: string) =>
  access(target).then(
    () => true,
    () => false,
  )

const quote = (arg: string) => `'${arg.replaceAll("'", `'\\''`)}'`
