export * as PlatformProviders from "./providers.js"

import { Effect } from "effect"
import { Credential } from "../credential.js"
import { Integration } from "../integration.js"
import { Model } from "../model.js"
import { Provider } from "../provider.js"

type Shared = Extract<Credential.Value, { type: "key" | "oauth" }>

/**
 * A provider the platform shares, with its real credential (a sign-in already refreshed) and its models. Only the
 * control plane reads this; it hands VMs the credential (never a refresh token) and they call the provider directly.
 */
export type Exported = {
  id: string
  integrationID: string
  value: Shared
  models: { id: string; api: string }[]
}

// Packages that sign requests with cloud credentials or run a local tool: a shared key or sign-in can't drive them.
const UNSHAREABLE = ["amazon-bedrock", "google-vertex", "claude-agent", "sap-ai-core", "snowflake", "databricks"]

/** Whether a provider package can be shared: false for ones that sign requests themselves. */
export function shareable(packageName: string | undefined) {
  const name = Provider.packageName(packageName)
  return !!name && !UNSHAREABLE.some((part) => name.includes(part))
}

/** The providers that can be shared: connected with a key or a sign-in, and shareable. */
export function select(input: {
  providers: readonly { id: string; integrationID?: string; package?: string }[]
  models: readonly { id: string; modelID?: string; providerID: string }[]
  credentials: ReadonlyMap<string, Credential.Value>
}): Exported[] {
  return input.providers.flatMap((provider) => {
    const value = input.credentials.get(provider.id)
    if (!shareable(provider.package) || (value?.type !== "key" && value?.type !== "oauth")) return []
    const integrationID = provider.integrationID ?? provider.id
    const models = input.models.filter((model) => model.providerID === provider.id)
    return [
      {
        id: provider.id,
        integrationID,
        value,
        models: models.map((model) => ({ id: model.id, api: model.modelID ?? model.id })),
      },
    ]
  })
}

/** On the platform server: the providers its admin connected, each with its current credential. */
export const current = Effect.gen(function* () {
  const providers = yield* Provider.Service
  const models = yield* Model.Service
  const integrations = yield* Integration.Service
  const available = yield* providers.available()
  const all = yield* models.all()
  const credentials = new Map<string, Credential.Value>()
  for (const provider of available) {
    const connection = yield* integrations.connection.active(provider.integrationID ?? Integration.ID.make(provider.id))
    // Resolving refreshes a sign-in that is about to expire; one that can't be resolved is left out.
    const value = connection
      ? yield* integrations.connection.resolve(connection).pipe(Effect.orElseSucceed(() => undefined))
      : undefined
    if (value) credentials.set(provider.id, value)
  }
  return select({ providers: available, models: all, credentials })
})

/** On the platform server: a user's sign-in refreshed by its integration's own code; undefined when it can't be. */
export const refresh = (input: { integrationID: string; value: Credential.OAuth }) =>
  Effect.gen(function* () {
    const integrations = yield* Integration.Service
    return yield* integrations.connection
      .refresh(Integration.ID.make(input.integrationID), input.value)
      .pipe(Effect.orElseSucceed(() => undefined))
  })
