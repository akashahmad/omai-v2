export * as PlatformProviders from "./providers.js"

import { Effect } from "effect"
import { Credential } from "../credential.js"
import { Integration } from "../integration.js"
import { Model } from "../model.js"
import { Provider } from "../provider.js"

type Shared = Extract<Credential.Value, { type: "key" | "oauth" }>

/**
 * A provider the platform shares, with its real credential (a sign-in already refreshed), the hosts it may be sent to
 * and its models. Only the control plane reads this; VMs hold a stand-in and call through the control plane's gateway.
 */
export type Exported = {
  id: string
  integrationID: string
  value: Shared
  hosts: string[]
  models: { id: string; api: string }[]
}

// Packages that sign requests with cloud credentials or run a local tool: a swapped header can't stand in for them.
const UNSHAREABLE = ["amazon-bedrock", "google-vertex", "claude-agent", "sap-ai-core", "snowflake", "databricks"]

// Hosts a provider's own code calls besides its models' base URLs: token exchanges and sign-in-specific APIs.
const EXTRA_HOSTS: Record<string, string[]> = {
  openai: ["chatgpt.com"],
  "github-copilot": [
    "api.github.com",
    "api.individual.githubcopilot.com",
    "api.business.githubcopilot.com",
    "api.enterprise.githubcopilot.com",
  ],
}

// Where a package sends requests when no base URL is configured.
const DEFAULT_BASES: [RegExp, string][] = [
  [/(^|\/)anthropic(\/|$)/, "https://api.anthropic.com/v1"],
  [/(^|\/)google(\/|$)/, "https://generativelanguage.googleapis.com/v1beta"],
  [/(^|\/)openai(\/(chat|responses|images))?$/, "https://api.openai.com/v1"],
]

/** Whether a provider package can be shared through the gateway: false for ones that sign requests themselves. */
export function shareable(packageName: string | undefined) {
  const name = Provider.packageName(packageName)
  return !!name && !UNSHAREABLE.some((part) => name.includes(part))
}

/** A provider's API base: its configured `baseURL`, or the address its package uses by default. */
export function base(provider: { package?: string; settings?: { readonly [key: string]: unknown } }) {
  const configured = provider.settings?.baseURL
  if (typeof configured === "string" && configured) return configured
  const name = Provider.packageName(provider.package)
  return name ? DEFAULT_BASES.find(([pattern]) => pattern.test(name))?.[1] : undefined
}

/** The providers the gateway can serve: connected with a key or a sign-in, shareable, with every host they use. */
export function select(input: {
  providers: readonly {
    id: string
    integrationID?: string
    package?: string
    settings?: { readonly [key: string]: unknown }
  }[]
  models: readonly {
    id: string
    modelID?: string
    providerID: string
    settings?: { readonly [key: string]: unknown }
  }[]
  credentials: ReadonlyMap<string, Credential.Value>
}): Exported[] {
  return input.providers.flatMap((provider) => {
    const value = input.credentials.get(provider.id)
    if (!shareable(provider.package) || (value?.type !== "key" && value?.type !== "oauth")) return []
    const integrationID = provider.integrationID ?? provider.id
    const models = input.models.filter((model) => model.providerID === provider.id)
    const hosts = hostsOf(provider, models)
    if (hosts.length === 0) return []
    return [
      {
        id: provider.id,
        integrationID,
        value,
        hosts,
        models: models.map((model) => ({ id: model.id, api: model.modelID ?? model.id })),
      },
    ]
  })
}

/** Every host a provider's requests go to: its base, its models' bases and its integration's extra hosts. */
export function hostsOf(
  provider: { id: string; integrationID?: string; package?: string; settings?: { readonly [key: string]: unknown } },
  models: readonly { settings?: { readonly [key: string]: unknown } }[],
) {
  const hosts = [base(provider), ...models.map((model) => model.settings?.baseURL)].flatMap((item) => {
    const host = typeof item === "string" ? URL.parse(item)?.host : undefined
    return host ? [host] : []
  })
  if (hosts.length === 0) return []
  return [...new Set([...hosts, ...(EXTRA_HOSTS[provider.integrationID ?? provider.id] ?? [])])]
}

/** The hosts of every shareable integration, connected or not, so the gateway can check a user's own sign-ins too. */
export function hostsByIntegration(input: Parameters<typeof select>[0]) {
  const entries = input.providers.flatMap((provider) => {
    if (!shareable(provider.package)) return []
    const hosts = hostsOf(
      provider,
      input.models.filter((model) => model.providerID === provider.id),
    )
    return hosts.length > 0 ? [[provider.integrationID ?? provider.id, hosts] as const] : []
  })
  const merged = new Map<string, string[]>()
  for (const [integrationID, hosts] of entries)
    merged.set(integrationID, [...new Set([...(merged.get(integrationID) ?? []), ...hosts])])
  return Object.fromEntries(merged)
}

/** On the platform server: the providers its admin connected, each with its current credential, for the gateway. */
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

/** On the platform server: every shareable integration's hosts. */
export const hosts = Effect.gen(function* () {
  const providers = yield* Provider.Service
  const models = yield* Model.Service
  return hostsByIntegration({ providers: yield* providers.all(), models: yield* models.all(), credentials: new Map() })
})
