import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { define } from "@opencode/plugin/effect/plugin"
import { Global } from "@opencode/util/global"
import { Duration, Effect, Schedule, Schema, Stream } from "effect"
import { Bus } from "../../bus.js"
import { Credential } from "../../credential.js"
import { Model } from "../../model.js"
import { Provider } from "../../provider.js"

export * as PlatformKeys from "./platform-keys.js"

export type Target = { url: string; projectID: string; token: string }

/** An admin-shared provider: its real key and the models switched on for everyone. */
export type Shared = { id: string; key: string; models: readonly string[] }

const SharedList = Schema.Array(
  Schema.Struct({ id: Schema.String, key: Schema.String, models: Schema.Array(Schema.String) }),
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
 * The shared providers to turn on: each with its real key, keeping only switched-on models. A provider the user
 * connected with their own credential is left to it; every other provider behaves as usual.
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
        apiKey: item.key,
        remove: provider.models.filter((model) => !switched.has(model.id)).map((model) => model.id),
      },
    ]
  })
}

/** Keeps the last list, readable only by this VM's own user, for starts while the control plane is unreachable. */
export async function save(file: string, shared: readonly Shared[]) {
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify(shared), { mode: 0o600 })
}

export async function restore(file: string): Promise<Shared[]> {
  const decoded = decodeShared(await readFile(file, "utf8").catch(() => ""))
  return decoded._tag === "Some" ? decoded.value.map((item) => ({ ...item, models: [...item.models] })) : []
}

/**
 * On a project's MicroVM: offers the admin's shared providers with their real keys (only switched-on models), unless
 * the user connected that provider themselves. Model calls go straight to the provider.
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
    const personal = credentials.all().pipe(Effect.map((all) => new Set(all.map((item) => String(item.integrationID)))))
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
    yield* ctx.provider.transform((providers) => {
      const defs = providers.list().map((definition) => ({
        id: definition.provider.id,
        integrationID: definition.provider.integrationID,
        models: [...definition.models.values()].map((model) => ({ id: model.id })),
      }))
      for (const item of plan(defs, state.shared, state.personal)) {
        const providerID = Provider.ID.make(item.id)
        providers.update(providerID, (provider) => {
          provider.activation = "enabled"
          provider.settings = { ...provider.settings, apiKey: item.apiKey }
        })
        for (const modelID of item.remove) providers.models.remove(providerID, Model.ID.make(modelID))
      }
    })
    yield* refresh.pipe(
      Effect.flatMap((changed) => (changed ? ctx.provider.reload() : Effect.void)),
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
          yield* ctx.provider.reload()
        }),
      ),
      Effect.forkScoped({ startImmediately: true }),
    )
  }),
})
