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
import { PublishRemote } from "./remote.js"
import { PublishDeployTable, PublishDomainTable, PublishSiteTable } from "./sql.js"
import { ProjectVmBusy } from "../project-vm/busy.js"

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

/** The site a publish uploads to; `first` while no version of it is live yet. */
type Target = { name: string; first: boolean }
type Platform = { configured: boolean; zone?: string; site?: Publish.Site }

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

    // On a project's MicroVM the control plane owns the site and does every Cloudflare call. Read per call, so the
    // environment decides, as it does for the local Cloudflare settings.
    const remote = () => {
      const target = PublishRemote.target(process.env)
      return target ? PublishRemote.client(target) : undefined
    }
    // The last answer per project, shown while the control plane can't be reached.
    const known = new Map<string, Platform>()

    const siteOf = (projectID: string) =>
      db.select().from(PublishSiteTable).where(eq(PublishSiteTable.project_id, projectID)).get().pipe(Effect.orDie)

    const localPlatform = Effect.fnUntraced(function* (projectID: string) {
      const config = PublishConfig.read()
      const site = yield* siteOf(projectID)
      const primary = yield* db
        .select({ hostname: PublishDomainTable.hostname })
        .from(PublishDomainTable)
        .where(and(eq(PublishDomainTable.project_id, projectID), eq(PublishDomainTable.is_primary, true)))
        .get()
        .pipe(Effect.orDie)
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
      } satisfies Platform
    })

    const remotePlatform = (client: PublishRemote.Client, projectID: string) =>
      Effect.promise(() =>
        client.status().then(
          (answer): Platform => {
            const platform = {
              configured: answer.configured,
              ...(answer.zone ? { zone: answer.zone } : {}),
              ...(answer.site ? { site: answer.site } : {}),
            }
            known.set(projectID, platform)
            return platform
          },
          (): Platform => known.get(projectID) ?? { configured: true },
        ),
      )

    const platformOf = (projectID: string) => {
      const client = remote()
      return client ? remotePlatform(client, projectID) : localPlatform(projectID)
    }

    const status = Effect.fnUntraced(function* (projectID: string, directory: string) {
      const platform = yield* platformOf(projectID)
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
        ...platform,
        ...(running ? { running: running } : {}),
        history: rows.filter((row) => row.id !== running?.id).map(fromRow),
        detected:
          "error" in detected ? { reason: detected.error } : { kind: detected.kind, framework: detected.framework },
      } satisfies Publish.Status
    })

    const notify = (projectID: string) => PubSub.publish(changed, projectID).pipe(Effect.asVoid)

    const available = Effect.fnUntraced(function* (projectID: string, name: string) {
      const client = remote()
      if (client) return yield* forward(() => client.available(name))
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
      const client = remote()
      if (client) {
        const site = (yield* remotePlatform(client, projectID)).site
        if (site) return { name: site.name, first: !site.publishedAt } satisfies Target
        if (!name) return yield* new PublishError({ kind: "invalid", message: "Choose a name for the site." })
        const claimed = yield* forward(() => client.claim(name))
        return { name: claimed.name, first: !claimed.publishedAt } satisfies Target
      }
      const config = yield* requireConfig()
      const existing = yield* siteOf(projectID)
      if (existing) return { name: existing.name, first: !existing.time_published } satisfies Target
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
      return { name, first: true } satisfies Target
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
        // On a MicroVM, a publish in progress keeps the VM from pausing until the run is recorded as finished.
        const release = ProjectVmBusy.hold("publish")
        void Effect.runPromise(Deferred.await(entry.done)).then(release, release)
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
      const client = remote()
      const upload = client ? { remote: client } : { config: yield* requireConfig() }
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
      yield* execute({ projectID: input.projectID, directory: input.directory, upload, site, entry }).pipe(
        Effect.forkIn(lifetime, { startImmediately: true }),
      )
      yield* notify(input.projectID)
      return entry.deploy
    })

    const execute = Effect.fnUntraced(function* (input: {
      projectID: string
      directory: string
      upload: { config: PublishConfig.Config } | { remote: PublishRemote.Client }
      site: Target
      entry: Running
    }) {
      const entry = input.entry
      const first = input.site.first
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
          upload: input.upload,
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

      // On a VM the control plane recorded the live version itself.
      if (result.ok && "config" in input.upload) {
        yield* db
          .update(PublishSiteTable)
          .set({ kind: result.kind, time_published: now })
          .where(eq(PublishSiteTable.project_id, input.projectID))
          .run()
          .pipe(Effect.orDie)
      }
      if (result.ok) entry.deploy = { ...entry.deploy, status: "live", kind: result.kind, finishedAt: now, stages }

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
        const upload = input.upload
        if (first && "remote" in upload)
          yield* Effect.promise(() => upload.remote.release()).pipe(
            Effect.catchCause(() =>
              Effect.sync(() => entry.log.append("\nReleasing the reserved name failed.\n")),
            ),
          )
        if (first && "config" in upload) {
          const cf = Cloudflare.client(upload.config)
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
      const client = remote()
      if (client) {
        const running = runs.get(projectID)
        if (running) {
          running.abort.abort()
          yield* Deferred.await(running.done)
        }
        yield* forward(() => client.remove(confirm))
        known.delete(projectID)
        return yield* notify(projectID)
      }
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

/** Calls the control plane, reporting its refusals as they are. */
function forward<A>(work: () => Promise<A>) {
  return Effect.tryPromise({
    try: work,
    catch: (error) =>
      error instanceof PublishRemote.RemoteError
        ? new PublishError({ kind: error.kind, message: error.message })
        : new PublishError({ kind: "other", message: error instanceof Error ? error.message : "The request failed." }),
  })
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
