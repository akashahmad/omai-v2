export * as PlatformProviders from "./providers.js"

import { Effect } from "effect"
import { Integration } from "../integration.js"
import { Model } from "../model.js"
import { Provider } from "../provider.js"

/** How a provider's API takes its key. */
export type Auth = "bearer" | "x-api-key" | "x-goog-api-key"

/** `models` maps each catalog model ID to the name its API takes in requests. */
export type Exported = { id: string; auth: Auth; key: string; bases: string[]; models: { id: string; api: string }[] }

// Packages whose APIs sign requests, use cloud credentials or personal sign-ins: never shared through the gateway.
const UNSUPPORTED = [
  "amazon-bedrock",
  "google-vertex",
  "azure",
  "cloudflare",
  "claude-agent",
  "github-copilot",
  "chatgpt",
  "gitlab",
  "sap-ai-core",
  "snowflake",
  "databricks",
  "modal",
]

// Where a package sends requests when no base URL is configured.
const DEFAULT_BASES: [RegExp, string][] = [
  [/(^|\/)anthropic(\/|$)/, "https://api.anthropic.com/v1"],
  [/(^|\/)google(\/|$)/, "https://generativelanguage.googleapis.com/v1beta"],
  [/(^|\/)openai(\/(chat|responses|images))?$/, "https://api.openai.com/v1"],
]

/** The header a provider package sends its API key in; undefined for packages the gateway doesn't support. */
export function auth(packageName: string | undefined): Auth | undefined {
  const name = Provider.packageName(packageName)
  if (!name || UNSUPPORTED.some((part) => name.includes(part))) return undefined
  if (/(^|\/)anthropic(-compatible)?(\/|$)/.test(name)) return "x-api-key"
  if (/(^|\/)google(\/|$)/.test(name)) return "x-goog-api-key"
  return "bearer"
}

/** A provider's API base: its configured `baseURL`, or the address its package uses by default. */
export function base(provider: { package?: string; settings?: { readonly [key: string]: unknown } }) {
  const configured = provider.settings?.baseURL
  if (typeof configured === "string" && configured) return configured
  const name = Provider.packageName(provider.package)
  return name ? DEFAULT_BASES.find(([pattern]) => pattern.test(name))?.[1] : undefined
}

/** The providers the gateway can serve: connected with an API key, supported, and with every API base they use. */
export function select(input: {
  providers: readonly { id: string; package?: string; settings?: { readonly [key: string]: unknown } }[]
  models: readonly {
    id: string
    modelID?: string
    providerID: string
    settings?: { readonly [key: string]: unknown }
  }[]
  keys: ReadonlyMap<string, { type: string; key?: string }>
}): Exported[] {
  return input.providers.flatMap((provider) => {
    const style = auth(provider.package)
    const credential = input.keys.get(provider.id)
    if (!style || credential?.type !== "key" || !credential.key) return []
    const models = input.models.filter((model) => model.providerID === provider.id)
    const bases = [base(provider), ...models.map((model) => model.settings?.baseURL)].filter(
      (value): value is string => typeof value === "string" && value !== "",
    )
    const unique = [...new Set(bases)]
    if (unique.length === 0) return []
    return [
      {
        id: provider.id,
        auth: style,
        key: credential.key,
        bases: unique,
        models: models.map((model) => ({ id: model.id, api: model.modelID ?? model.id })),
      },
    ]
  })
}

/** On the platform server: the providers its admin connected, with their keys, for the control plane's gateway. */
export const current = Effect.gen(function* () {
  const providers = yield* Provider.Service
  const models = yield* Model.Service
  const integrations = yield* Integration.Service
  const available = yield* providers.available()
  const all = yield* models.all()
  const keys = new Map<string, { type: string; key?: string }>()
  for (const provider of available) {
    const connection = yield* integrations.connection.active(provider.integrationID ?? Integration.ID.make(provider.id))
    // A sign-in that can't be resolved is left out, like a provider without a key.
    const credential = connection
      ? yield* integrations.connection.resolve(connection).pipe(Effect.orElseSucceed(() => undefined))
      : undefined
    if (credential?.type === "key") keys.set(provider.id, { type: "key", key: credential.key })
  }
  return select({ providers: available, models: all, keys })
})
