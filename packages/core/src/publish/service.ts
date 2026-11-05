export * as PublishService from "./service.js"

import { randomUUID } from "node:crypto"
import { and, desc, eq, inArray } from "drizzle-orm"
import { Context, Deferred, Effect, Layer, PubSub, Schema, Scope, Stream } from "effect"
import { Publish } from "@opencode/schema/publish"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { Global } from "@opencode/util/global"
import { Database } from "../database/database.js"
import { LogBuffer } from "../preview/process.js"
import { Cloudflare, CloudflareError } from "./cloudflare.js"
import { PublishConfig } from "./config.js"
import { detectKind } from "./detect.js"
import { validName } from "./name.js"
import { LOG_TAIL, run } from "./pipeline.js"
import { PublishDeployTable, PublishDomainTable, PublishSiteTable } from "./sql.js"

/** Deploys kept per project. */
export const HISTORY = 10

export class PublishError extends Schema.TaggedError<PublishError>()("Publish.Error", {
  kind: Publish.FailureKind,
  message: Schema.String,
}) {}

export interface Interface {
  readonly status: (projectID: string, directory: string) => Effect.Effect<Publish.Status>
  /** Whether `name` can become this project's site name. */
  readonly available: (
    projectID: string,
    name: string,
  ) => Effect.Effect<{ available: boolean; reason?: string }, PublishError>
  /** Starts a publish, or returns the one already running for the project. `name` is used on first publish only. */
  readonly publish: (input: {
    projectID: string
    directory: string
    name?: string
    sessionID?: string
  }) => Effect.Effect<Publish.Deploy, PublishError>
  /** Stops the running publish and waits until it is recorded as cancelled. */
  readonly cancel: (projectID: string) => Effect.Effect<void>
  readonly log: (projectID: string, id: string) => Effect.Effect<string>
  /** Deletes the site: its script, KV keys, custom hostnames and rows. `confirm` must be the site name. */
  readonly remove: (projectID: string, confirm: string) => Effect.Effect<void, PublishError>
  /** The project's status after every change. */
  readonly changes: (projectID: string, directory: string) => Stream.Stream<Publish.Status>
  /** Output of the project's running publish. */
  readonly logs: (projectID: string) => Stream.Stream<{ id: string; chunk: string }>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/PublishService") {}

type Running = {
  deploy: Publish.Deploy
  abort: AbortController
  log: LogBuffer
  /** Settles once the deploy is recorded and forked, or with the reason it could not start. */
  ready: Deferred.Deferred<Publish.Deploy, PublishError>
  done: Deferred.Deferred<void>
}

type Site = typeof PublishSiteTable.$inferSelect

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const global = yield* Global.Service
    const lifetime = yield* Scope.Scope
    const runs = new Map<string, Running>()
    const changed = yield* PubSub.unbounded<string>()
    const logged = yield* PubSub.unbounded<{ projectID: string; id: string; chunk: string }>()

    // A deploy still "running" in the database lost its process.
    yield* db
      .update(PublishDeployTable)
      .set({ status: "failed", error: "The server stopped during the publish.", time_finished: Date.now() })
      .where(eq(PublishDeployTable.status, "running"))
      .run()
      .pipe(Effect.orDie)

    const siteOf = (projectID: string) =>
      db.select().from(PublishSiteTable).where(eq(PublishSiteTable.project_id, projectID)).get().pipe(Effect.orDie)

    const status = Effect.fnUntraced(function* (projectID: string, directory: string) {
      const config = PublishConfig.read()
      const site = yield* siteOf(projectID)
      const primary = yield* db
        .select({ hostname: PublishDomainTable.hostname })
        .from(PublishDomainTable)
        .where(and(eq(PublishDomainTable.project_id, projectID), eq(PublishDomainTable.is_primary, true)))
        .get()
        .pipe(Effect.orDie)
      const running = runs.get(projectID)?.deploy
      const rows = yield* db
        .select()
        .from(PublishDeployTable)
        .where(eq(PublishDeployTable.project_id, projectID))
        .orderBy(desc(PublishDeployTable.time_started))
        .limit(HISTORY)
        .all()
        .pipe(Effect.orDie)
      const detected = yield* Effect.promise(() => detectKind(directory))
      return {
        configured: config !== undefined,
        ...(config ? { zone: config.zone } : {}),
        ...(site && config
          ? {
              site: {
                name: site.name,
                url: `https://${site.name}.${config.zone}`,
                zone: config.zone,
                ...(site.kind ? { kind: decodeKind(site.kind) } : {}),
                ...(site.time_published ? { publishedAt: site.time_published } : {}),
                ...(primary ? { primary: primary.hostname } : {}),
              },
            }
          : {}),
        ...(running ? { running: running } : {}),
        history: rows.filter((row) => row.id !== running?.id).map(fromRow),
        detected:
          "error" in detected ? { reason: detected.error } : { kind: detected.kind, framework: detected.framework },
      } satisfies Publish.Status
    })

    const notify = (projectID: string) => PubSub.publish(changed, projectID).pipe(Effect.asVoid)

    const available = Effect.fnUntraced(function* (projectID: string, name: string) {
      const config = yield* requireConfig()
      const invalid = validName(name)
      if (invalid) return { available: false, reason: invalid }
      const site = yield* db.select().from(PublishSiteTable).where(eq(PublishSiteTable.name, name)).get().pipe(Effect.orDie)
      if (site) return site.project_id === projectID ? { available: true } : taken
      const cf = Cloudflare.client(config)
      return yield* cloudflare(async () => {
        if ((await cf.scriptExists(name)) && (await cf.scriptOwner(name)) !== projectID) return taken
        if (await cf.hasRecord(`${name}.${config.zone}`)) return taken
        return { available: true }
      })
    })

    /** Reserves the name for a first publish: our row first (unique), then the placeholder when no script exists. */
    const claim = Effect.fnUntraced(function* (projectID: string, name: string | undefined) {
      const config = yield* requireConfig()
      const existing = yield* siteOf(projectID)
      if (existing) return existing
      if (!name) return yield* new PublishError({ kind: "invalid", message: "Choose a name for the site." })
      const free = yield* available(projectID, name)
      if (!free.available)
        return yield* new PublishError({ kind: validName(name) ? "invalid" : "taken", message: free.reason ?? "" })
      const now = Date.now()
      const row = { project_id: projectID, name, time_created: now, time_updated: now }
      yield* db
        .insert(PublishSiteTable)
        .values(row)
        .run()
        .pipe(Effect.mapError(() => new PublishError({ kind: "taken", message: taken.reason })))
      const cf = Cloudflare.client(config)
      yield* cloudflare(async () => {
        if (!(await cf.scriptExists(name))) await cf.claimScript(name, projectID)
      }).pipe(Effect.tapError(() => release(projectID)))
      return yield* siteOf(projectID).pipe(Effect.map((site) => site ?? { ...row, kind: null, time_published: null }))
    })

    const release = (projectID: string) =>
      db.delete(PublishSiteTable).where(eq(PublishSiteTable.project_id, projectID)).run().pipe(Effect.orDie)

    const publish: Interface["publish"] = (input) =>
      Effect.gen(function* () {
        const existing = runs.get(input.projectID)
        if (existing) {
          yield* Deferred.await(existing.ready)
          return existing.deploy
        }
        const entry: Running = {
          deploy: { id: `dep_${randomUUID()}`, status: "running", startedAt: Date.now(), stages: [] },
          abort: new AbortController(),
          log: new LogBuffer(),
          ready: Deferred.makeUnsafe(),
          done: Deferred.makeUnsafe(),
        }
        // Registered before the first yield, so a concurrent call joins this run.
        runs.set(input.projectID, entry)
        const started = yield* start(input, entry).pipe(
          // Also on interruption, so a caller that goes away never leaves the project looking busy.
          Effect.onError((cause) =>
            Effect.gen(function* () {
              runs.delete(input.projectID)
              yield* Deferred.failCause(entry.ready, cause)
              yield* Deferred.succeed(entry.done, undefined)
            }),
          ),
        )
        yield* Deferred.succeed(entry.ready, started)
        return started
      })

    const start = Effect.fnUntraced(function* (
      input: { projectID: string; directory: string; name?: string; sessionID?: string },
      entry: Running,
    ) {
      const config = yield* requireConfig()
      const site = yield* claim(input.projectID, input.name)
      yield* db
        .insert(PublishDeployTable)
        .values({
          id: entry.deploy.id,
          project_id: input.projectID,
          status: "running",
          stages: "[]",
          session_id: input.sessionID ?? null,
          time_started: entry.deploy.startedAt,
        })
        .run()
        .pipe(Effect.orDie)
      yield* execute({ projectID: input.projectID, directory: input.directory, config, site, entry }).pipe(
        Effect.forkIn(lifetime, { startImmediately: true }),
      )
      yield* notify(input.projectID)
      return entry.deploy
    })

    const execute = Effect.fnUntraced(function* (input: {
      projectID: string
      directory: string
      config: PublishConfig.Config
      site: Site
      entry: Running
    }) {
      const entry = input.entry
      const first = !input.site.time_published
      const onStage = (stage: Publish.Stage) => {
        const now = Date.now()
        entry.deploy = {
          ...entry.deploy,
          stage,
          stages: [
            ...entry.deploy.stages.map((item) => (item.finishedAt ? item : { ...item, finishedAt: now })),
            { stage, startedAt: now },
          ],
        }
        PubSub.publishUnsafe(changed, input.projectID)
      }
      const onLog = (chunk: string) => {
        entry.log.append(chunk)
        PubSub.publishUnsafe(logged, { projectID: input.projectID, id: entry.deploy.id, chunk })
      }
      const result = yield* Effect.promise(() =>
        run({
          projectID: input.projectID,
          directory: input.directory,
          dataDir: global.data,
          name: input.site.name,
          config: input.config,
          first,
          signal: entry.abort.signal,
          onStage,
          onLog,
        }).then(
          (value) => ({ ok: true as const, kind: value.kind }),
          (error: unknown) => ({ ok: false as const, error }),
        ),
      ).pipe(
        // Shutdown interrupts the fiber; the build processes must stop with it. The row stays "running" and is
        // recorded as failed at the next start.
        Effect.onInterrupt(() => Effect.sync(() => entry.abort.abort())),
      )
      const now = Date.now()
      const stages = entry.deploy.stages.map((item) => (item.finishedAt ? item : { ...item, finishedAt: now }))

      if (result.ok) {
        yield* db
          .update(PublishSiteTable)
          .set({ kind: result.kind, time_published: now })
          .where(eq(PublishSiteTable.project_id, input.projectID))
          .run()
          .pipe(Effect.orDie)
        entry.deploy = { ...entry.deploy, status: "live", kind: result.kind, finishedAt: now, stages }
      }

      if (!result.ok) {
        const cancelled = entry.abort.signal.aborted
        // A PublishFailure carries a plain reason; anything else is an unexpected error, still shown by message.
        const message = result.error instanceof Error ? result.error.message : String(result.error)
        entry.deploy = {
          ...entry.deploy,
          status: cancelled ? "cancelled" : "failed",
          ...(cancelled ? {} : { error: message }),
          finishedAt: now,
          stages,
        }
        // A site that was live keeps its script: the upload replaces it atomically, so the old version still serves.
        if (first) {
          const cf = Cloudflare.client(input.config)
          yield* Effect.promise(async () => {
            if ((await cf.scriptOwner(input.site.name)) === input.projectID) await cf.deleteScript(input.site.name)
          }).pipe(
            Effect.catchCause(() =>
              Effect.sync(() => entry.log.append("\nReleasing the reserved name on Cloudflare failed.\n")),
            ),
          )
          yield* release(input.projectID)
        }
      }

      yield* db
        .update(PublishDeployTable)
        .set({
          status: entry.deploy.status,
          stage: entry.deploy.stage ?? null,
          kind: entry.deploy.kind ?? null,
          error: entry.deploy.error ?? null,
          stages: JSON.stringify(entry.deploy.stages),
          log: entry.log.tail(LOG_TAIL),
          time_finished: now,
        })
        .where(eq(PublishDeployTable.id, entry.deploy.id))
        .run()
        .pipe(Effect.orDie)
      yield* prune(input.projectID)
    }, (effect, input) =>
      effect.pipe(
        Effect.ensuring(
          Effect.gen(function* () {
            runs.delete(input.projectID)
            yield* Deferred.succeed(input.entry.done, undefined)
            yield* notify(input.projectID)
          }),
        ),
      ),
    )

    const prune = Effect.fnUntraced(function* (projectID: string) {
      const old = yield* db
        .select({ id: PublishDeployTable.id })
        .from(PublishDeployTable)
        .where(eq(PublishDeployTable.project_id, projectID))
        .orderBy(desc(PublishDeployTable.time_started))
        .limit(-1)
        .offset(HISTORY)
        .all()
        .pipe(Effect.orDie)
      if (old.length === 0) return
      yield* db
        .delete(PublishDeployTable)
        .where(
          inArray(
            PublishDeployTable.id,
            old.map((row) => row.id),
          ),
        )
        .run()
        .pipe(Effect.orDie)
    })

    const remove = Effect.fnUntraced(function* (projectID: string, confirm: string) {
      const config = yield* requireConfig()
      const site = yield* siteOf(projectID)
      if (!site) return yield* new PublishError({ kind: "not-published", message: "This project has no site." })
      if (confirm !== site.name)
        return yield* new PublishError({ kind: "invalid", message: `Type ${site.name} to delete the site.` })
      const running = runs.get(projectID)
      if (running) {
        running.abort.abort()
        yield* Deferred.await(running.done)
      }
      const domains = yield* db
        .select()
        .from(PublishDomainTable)
        .where(eq(PublishDomainTable.project_id, projectID))
        .all()
        .pipe(Effect.orDie)
      const cf = Cloudflare.client(config)
      // Only what our rows name: this project's custom hostnames and its platform subdomain. A custom hostname is
      // deleted only by its recorded id; a row without one never got a hostname from Cloudflare that is ours.
      yield* cloudflare(async () => {
        await Promise.all(
          [...domains.map((domain) => domain.hostname), `${site.name}.${config.zone}`].map((host) => cf.kvDelete(host)),
        )
        await Promise.all(
          domains.flatMap((domain) => (domain.cf_id ? [cf.deleteHostname(domain.cf_id)] : [])),
        )
        await cf.deleteScript(site.name)
      })
      yield* db.delete(PublishDomainTable).where(eq(PublishDomainTable.project_id, projectID)).run().pipe(Effect.orDie)
      yield* db.delete(PublishDeployTable).where(eq(PublishDeployTable.project_id, projectID)).run().pipe(Effect.orDie)
      yield* release(projectID)
      yield* notify(projectID)
    })

    return Service.of({
      status,
      available,
      publish,
      cancel: (projectID) =>
        Effect.gen(function* () {
          const running = runs.get(projectID)
          if (!running) return
          running.abort.abort()
          yield* Deferred.await(running.done)
        }),
      log: (projectID, id) =>
        Effect.gen(function* () {
          const running = runs.get(projectID)
          if (running?.deploy.id === id) return running.log.text()
          const row = yield* db
            .select({ log: PublishDeployTable.log })
            .from(PublishDeployTable)
            .where(and(eq(PublishDeployTable.project_id, projectID), eq(PublishDeployTable.id, id)))
            .get()
            .pipe(Effect.orDie)
          return row?.log ?? ""
        }),
      remove,
      changes: (projectID, directory) =>
        Stream.fromPubSub(changed).pipe(
          Stream.filter((id) => id === projectID),
          Stream.mapEffect(() => status(projectID, directory)),
        ),
      logs: (projectID) =>
        Stream.fromPubSub(logged).pipe(
          Stream.filter((item) => item.projectID === projectID),
          Stream.map((item) => ({ id: item.id, chunk: item.chunk })),
        ),
    })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node, Global.node] })

const taken = { available: false, reason: "This name is taken. Choose another." }

const decodeKind = Schema.decodeUnknownSync(Publish.Kind)
const decodeStages = Schema.decodeUnknownSync(Schema.fromJsonString(Publish.Deploy.fields.stages))

function requireConfig() {
  const config = PublishConfig.read()
  if (config) return Effect.succeed(config)
  return Effect.fail(new PublishError({ kind: "not-configured", message: "Publishing isn't set up on this server." }))
}

/** Runs Cloudflare calls, reporting Cloudflare's own message and nothing from the raw response. */
function cloudflare<A>(work: () => Promise<A>) {
  return Effect.tryPromise({
    try: work,
    catch: (error) =>
      new PublishError({
        kind: "cloudflare",
        message: error instanceof CloudflareError || error instanceof Error ? error.message : "Cloudflare failed.",
      }),
  })
}

function fromRow(row: typeof PublishDeployTable.$inferSelect): Publish.Deploy {
  return {
    id: row.id,
    status: Schema.decodeUnknownSync(Publish.DeployStatus)(row.status),
    ...(row.stage ? { stage: Schema.decodeUnknownSync(Publish.Stage)(row.stage) } : {}),
    ...(row.kind ? { kind: decodeKind(row.kind) } : {}),
    ...(row.error ? { error: row.error } : {}),
    startedAt: row.time_started,
    ...(row.time_finished ? { finishedAt: row.time_finished } : {}),
    stages: decodeStages(row.stages),
  }
}
