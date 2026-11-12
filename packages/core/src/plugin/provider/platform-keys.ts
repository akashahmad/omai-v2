import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { define } from "@opencode/plugin/effect/plugin"
import { Global } from "@opencode/util/global"
import { Duration, Effect, Schedule, Schema, Stream } from "effect"
import { Bus } from "../../bus.js"
import { Credential } from "../../credential.js"
import { Model } from "../../model.js"
import { Integration } from "../../integration.js"
import { Provider } from "../../provider.js"

export * as PlatformKeys from "./platform-keys.js"

export type Target = { url: string; projectID: string; token: string }

/**
 * An admin-shared provider: its credential and the models switched on for everyone. The VM calls the provider with it
 * directly; a sign-in carries the managed refresh token, so it is refreshed through the control plane.
 */
export type Shared = {
  id: string
  integrationID: string
  value: Credential.Key | Credential.OAuth
  models: readonly string[]
}

/** Credentials for shared providers have this ID prefix; they are never synced as the user's own. */
export const SHARED_PREFIX = "cred_shared_"

const SharedList = Schema.Array(
  Schema.Struct({
    id: Schema.String,
    integrationID: Schema.String,
    value: Schema.Union([Credential.Key, Credential.OAuth]),
    models: Schema.Array(Schema.String),
  }),
)
const decodeShared = Schema.decodeUnknownOption(Schema.fromJsonString(SharedList))
// `shared` is absent while the control plane doesn't know the list yet: keep ours then.
const decodeAnswer = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ shared: Schema.optional(SharedList) })),
)

// Switches and keys an admin changes reach running VMs within this.
const REFRESH = Duration.seconds(60)

/** The control plane to ask, on a project's MicroVM only (never on the platform server). */
export function target(env: Record<string, string | undefined>): Target | undefined {
  const url = env.OMAI_CONTROL_PLANE_URL
  const projectID = env.OMAI_PROJECT_ID
  const token = env.OMAI_PROJECT_TOKEN
  if (!url || !projectID || !token || projectID === "platform") return undefined
  return { url: url.replace(/\/+$/, ""), projectID, token }
}

/**
 * The shared providers to trim: each keeps only its switched-on models. A provider the user connected with their own
 * credential is left to it; every other provider behaves as usual.
 */
export function plan(
  providers: readonly { id: string; integrationID?: string; models: readonly { id: string }[] }[],
  shared: readonly Shared[],
  personal: ReadonlySet<string>,
) {
  const byID = new Map(shared.map((item) => [item.id, item]))
  return providers.flatMap((provider) => {
    const item = byID.get(provider.id)
    if (!item || personal.has(provider.integrationID ?? provider.id)) return []
    const switched = new Set(item.models)
    return [
      {
        id: provider.id,
        remove: provider.models.filter((model) => !switched.has(model.id)).map((model) => model.id),
      },
    ]
  })
}

/** The credential each shared integration needs, unless the user connected it themselves. */
export function sharedCredentials(shared: readonly Shared[], personal: ReadonlySet<string>) {
  const integrations = new Map(shared.map((item) => [item.integrationID, item]))
  return [...integrations.values()].flatMap((item) =>
    personal.has(item.integrationID)
      ? []
      : [
          {
            id: `${SHARED_PREFIX}${item.integrationID}`,
            integrationID: item.integrationID,
            label: "Shared",
            value: item.value,
          },
        ],
  )
}

/**
 * Keeps the last list, readable only by this VM's own user, for starts while the control plane is unreachable. It holds
 * the shared keys, like the credentials this VM already stores.
 */
export async function save(file: string, shared: readonly Shared[]) {
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify(shared), { mode: 0o600 })
}

export async function restore(file: string): Promise<Shared[]> {
  const decoded = decodeShared(await readFile(file, "utf8").catch(() => ""))
  return decoded._tag === "Some" ? decoded.value.map((item) => ({ ...item, models: [...item.models] })) : []
}

/**
 * On a project's MicroVM: offers the admin's shared providers (only switched-on models) with their credentials, unless
 * the user connected that provider themselves. Calls go straight to the provider.
 */
export const Plugin = define({
  id: "omai.platform-keys",
  effect: Effect.fn(function* (ctx) {
    const found = target(process.env)
    if (!found) return
    const global = yield* Global.Service
    const credentials = yield* Credential.Service
    const bus = yield* Bus.Service
    const file = path.join(global.data, "platform-keys.json")
    const state = {
      shared: yield* Effect.promise(() => restore(file)),
      text: "",
      personal: new Set<string>(),
    }
    const personal = credentials
      .all()
      .pipe(
        Effect.map(
          (all) =>
            new Set(all.filter((item) => !item.id.startsWith(SHARED_PREFIX)).map((item) => String(item.integrationID))),
        ),
      )
    // Keeps the shared credentials in step with the shared list and the user's own credentials.
    const place = Effect.gen(function* () {
      const wanted = new Map(sharedCredentials(state.shared, state.personal).map((item) => [item.id, item]))
      const present = (yield* credentials.all()).filter((item) => item.id.startsWith(SHARED_PREFIX))
      for (const item of present) if (!wanted.has(item.id)) yield* credentials.remove(item.id).pipe(Effect.ignore)
      for (const item of wanted.values()) {
        const here = present.find((entry) => entry.id === item.id)
        if (here && JSON.stringify(here.value) === JSON.stringify(item.value)) continue
        if (here) yield* credentials.update(here.id, { label: item.label, value: item.value }).pipe(Effect.ignore)
        else
          yield* credentials
            .create({
              id: Credential.ID.make(item.id),
              integrationID: Integration.ID.make(item.integrationID),
              label: item.label,
              value: item.value,
            })
            .pipe(Effect.ignore)
      }
    })
    state.personal = yield* personal

    const refresh = Effect.gen(function* () {
      const text = yield* Effect.tryPromise(() =>
        fetch(`${found.url}/internal/projects/${encodeURIComponent(found.projectID)}/keys`, {
          headers: { authorization: `Bearer ${found.token}` },
          signal: AbortSignal.timeout(10_000),
        }).then((res) => (res.ok ? res.text() : undefined)),
      ).pipe(Effect.orElseSucceed(() => undefined))
      // Unreachable: keep what we have (the saved copy at start).
      if (text === undefined) return false
      const decoded = decodeAnswer(text)
      if (decoded._tag === "None" || !decoded.value.shared) return false
      const next = JSON.stringify(decoded.value.shared)
      if (next === state.text) return false
      state.text = next
      state.shared = decoded.value.shared.map((item) => ({ ...item, models: [...item.models] }))
      yield* Effect.promise(() => save(file, state.shared).catch(() => undefined))
      return true
    })

    yield* refresh
    yield* place
    yield* ctx.provider.transform((providers) => {
      const defs = providers.list().map((definition) => ({
        id: definition.provider.id,
        integrationID: definition.provider.integrationID,
        models: [...definition.models.values()].map((model) => ({ id: model.id })),
      }))
      for (const item of plan(defs, state.shared, state.personal))
        for (const modelID of item.remove) providers.models.remove(Provider.ID.make(item.id), Model.ID.make(modelID))
    })
    yield* refresh.pipe(
      Effect.flatMap((changed) => (changed ? place.pipe(Effect.andThen(ctx.provider.reload())) : Effect.void)),
      Effect.repeat(Schedule.spaced(REFRESH)),
      Effect.forkScoped({ startImmediately: true }),
    )
    // The user connecting or removing their own credential decides between it and the shared key.
    yield* bus.subscribe([Credential.Event.Updated]).pipe(
      Stream.runForEach(() =>
        Effect.gen(function* () {
          const next = yield* personal
          const same = next.size === state.personal.size && [...next].every((id) => state.personal.has(id))
          if (same) return
          state.personal = next
          yield* place
          yield* ctx.provider.reload()
        }),
      ),
      Effect.forkScoped({ startImmediately: true }),
    )
  }),
})
