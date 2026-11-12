export * as ProjectVmCredentials from "./credentials.js"

import { Duration, Effect, Schedule, Schema, Stream } from "effect"
import { Bus } from "../bus.js"
import { Credential } from "../credential.js"
import { Integration } from "../integration.js"
import { SHARED_PREFIX } from "../plugin/provider/platform-keys.js"
import { ProjectVmManaged } from "./managed.js"

type Local = { id: string; integrationID: string; label: string; value: unknown }
type Remote = Local & { updatedAt: number; deleted: boolean }
type Result = "ok" | "stale" | "forbidden" | "failed"

const Personal = Schema.Array(
  Schema.Struct({
    id: Schema.String,
    integrationID: Schema.String,
    label: Schema.String,
    value: Schema.Unknown,
    updatedAt: Schema.Number,
    deleted: Schema.Boolean,
  }),
)
const decodeAnswer = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Struct({ personal: Personal })))
const decodeValue = Schema.decodeUnknownOption(Credential.Value)
const decodeRefreshed = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ access: Schema.String, expires: Schema.Number })),
)

const REFRESH = Duration.seconds(60)

/**
 * Keeps a VM's credentials in step with its user's on the control plane, so a provider the user connects on one of
 * their projects works on all of them. A sign-in's refresh token lives on the control plane, which refreshes it;
 * projects hold its access token. `pull` applies the control plane's state, `push` sends only
 * what changed here since the last sync: what was just pulled is never sent back.
 */
export function create(input: {
  store: {
    all(): Promise<Local[]>
    /** False when the value can't be stored here (not a credential this server knows). */
    create(item: Local): Promise<boolean>
    update(id: string, item: { label: string; value: unknown }): Promise<boolean>
    remove(id: string): Promise<void>
  }
  server: {
    pull(): Promise<Remote[] | undefined>
    put(item: Local & { updatedAt: number }): Promise<Result>
    remove(id: string, at: number): Promise<Result>
  }
  now?: () => number
}) {
  const now = input.now ?? (() => Date.now())
  // What each credential looked like when last in step with the control plane; null once deleted there.
  const synced = new Map<string, string | null>()
  const queue = { last: Promise.resolve() }
  const serial = (run: () => Promise<void>) => {
    queue.last = queue.last.then(run, run)
    return queue.last
  }

  return {
    pull: () =>
      serial(async () => {
        const remote = await input.server.pull()
        if (!remote) return
        const local = new Map((await input.store.all()).filter(syncable).map((item) => [item.id, item]))
        for (const item of remote) {
          if (!item.deleted && !syncable(item)) continue
          const here = local.get(item.id)
          const last = synced.get(item.id)
          // A change made here and not yet sent (an edit, or a removal) wins until push sends it.
          if (here && last !== undefined && fingerprint(here) !== last) continue
          if (!here && typeof last === "string") continue
          if (item.deleted) {
            if (here) await input.store.remove(item.id)
            synced.set(item.id, null)
            continue
          }
          const fields = { id: item.id, integrationID: item.integrationID, label: item.label, value: item.value }
          const applied = here
            ? fingerprint(here) === fingerprint(item) || (await input.store.update(item.id, fields))
            : await input.store.create(fields)
          // Recorded only once it is here: otherwise push would take its absence for a removal.
          if (applied) synced.set(item.id, fingerprint(item))
        }
      }),

    push: () =>
      serial(async () => {
        const local = (await input.store.all()).filter(syncable)
        const present = new Set(local.map((item) => item.id))
        for (const item of local) {
          const print = fingerprint(item)
          if (synced.get(item.id) === print) continue
          if ((await input.server.put({ ...item, updatedAt: now() })) !== "ok") continue
          // The control plane keeps the sign-in's refresh token and refreshes it from now on.
          const kept = replaced(item)
          if (kept !== item && !(await input.store.update(item.id, { label: kept.label, value: kept.value }))) continue
          synced.set(item.id, fingerprint(kept))
        }
        for (const [id, print] of synced) {
          if (print === null || present.has(id)) continue
          if ((await input.server.remove(id, now())) === "ok") synced.set(id, null)
        }
      }),
  }
}

/** On a project's MicroVM: syncs the user's credentials at start, every minute, and whenever they change here. */
export const start = (target: { url: string; projectID: string; token: string }) =>
  Effect.gen(function* () {
    const credentials = yield* Credential.Service
    const bus = yield* Bus.Service
    const base = `${target.url}/internal/projects/${encodeURIComponent(target.projectID)}`
    const headers = { authorization: `Bearer ${target.token}`, "content-type": "application/json" }
    const run = <A>(effect: Effect.Effect<A>) => Effect.runPromise(effect)
    const result = (res: Response): Result => {
      if (res.status === 204) return "ok"
      if (res.status === 409) return "stale"
      return res.status === 404 ? "forbidden" : "failed"
    }
    // Sign-ins with the managed refresh token are refreshed here, once for all the user's VMs.
    ProjectVmManaged.register((credential) =>
      fetch(`${base}/credentials/refresh`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          ref: credential.id.startsWith(SHARED_PREFIX) ? `s~${credential.integrationID}` : `u~${credential.id}`,
        }),
        signal: AbortSignal.timeout(10_000),
      })
        .then(async (res) => {
          if (!res.ok) return undefined
          const decoded = decodeRefreshed(await res.text())
          return decoded._tag === "Some" ? decoded.value : undefined
        })
        .catch(() => undefined),
    )
    const sync = create({
      store: {
        all: () =>
          run(credentials.all()).then((all) =>
            all.map((item) => ({
              id: item.id,
              integrationID: item.integrationID,
              label: item.label,
              value: item.value,
            })),
          ),
        create: async (item) => {
          const value = decodeValue(item.value)
          if (value._tag === "None") return false
          await run(
            credentials.create({
              id: Credential.ID.make(item.id),
              integrationID: Integration.ID.make(item.integrationID),
              label: item.label,
              value: value.value,
            }),
          )
          return true
        },
        update: async (id, item) => {
          const value = decodeValue(item.value)
          if (value._tag === "None") return false
          await run(credentials.update(Credential.ID.make(id), { label: item.label, value: value.value }))
          return true
        },
        remove: (id) => run(credentials.remove(Credential.ID.make(id))),
      },
      server: {
        pull: () =>
          fetch(`${base}/keys`, { headers, signal: AbortSignal.timeout(10_000) })
            .then(async (res) => {
              if (!res.ok) return undefined
              const decoded = decodeAnswer(await res.text())
              return decoded._tag === "Some" ? decoded.value.personal.map((item) => ({ ...item })) : undefined
            })
            .catch(() => undefined),
        put: (item) =>
          fetch(`${base}/credentials/${encodeURIComponent(item.id)}`, {
            method: "PUT",
            headers,
            body: JSON.stringify({
              integrationID: item.integrationID,
              label: item.label,
              value: item.value,
              updatedAt: item.updatedAt,
            }),
            signal: AbortSignal.timeout(10_000),
          }).then(result, () => "failed" as const),
        remove: (id, at) =>
          fetch(`${base}/credentials/${encodeURIComponent(id)}?at=${at}`, {
            method: "DELETE",
            headers,
            signal: AbortSignal.timeout(10_000),
          }).then(result, () => "failed" as const),
      },
    })
    const round = Effect.promise(() => sync.pull().then(() => sync.push())).pipe(
      Effect.catchCause((cause) => Effect.logWarning("credential sync failed", cause)),
    )
    yield* round.pipe(Effect.repeat(Schedule.spaced(REFRESH)), Effect.forkScoped({ startImmediately: true }))
    yield* bus
      .subscribe([Credential.Event.Updated])
      .pipe(Stream.runForEach(() => Effect.promise(() => sync.push().catch(() => undefined))))
  })

/**
 * The user's API keys and sign-ins follow them to all their projects. A shared provider's credential is the admin's,
 * not theirs, and never syncs; an external credential (a cloud login on this machine) can't.
 */
function syncable(item: { id?: string; value: unknown }) {
  if (item.id?.startsWith(SHARED_PREFIX)) return false
  const type =
    typeof item.value === "object" && item.value !== null && "type" in item.value ? item.value.type : undefined
  return type === "key" || type === "oauth"
}

/** A sign-in as projects hold it once the control plane has it: its refresh token swapped for the managed one. */
function replaced(item: Local): Local {
  const value = item.value
  if (typeof value !== "object" || value === null || !("type" in value) || value.type !== "oauth") return item
  if ("refresh" in value && value.refresh === ProjectVmManaged.MANAGED_REFRESH) return item
  return { ...item, value: { ...value, refresh: ProjectVmManaged.MANAGED_REFRESH } }
}

/** A stable text for comparing credentials: object keys sorted, so the same value always reads the same. */
function fingerprint(item: { integrationID: string; label: string; value: unknown }) {
  return JSON.stringify([item.integrationID, item.label, canonical(item.value)])
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (typeof value !== "object" || value === null) return value
  return Object.fromEntries(
    Object.entries(value)
      .toSorted(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, canonical(item)]),
  )
}
