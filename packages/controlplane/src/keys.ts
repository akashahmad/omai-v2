import { and, eq } from "drizzle-orm"
import { Schema } from "effect"
import type { Config } from "./config.js"
import type { Db } from "./db/database.js"
import { ModelUsageTable, UserCredentialTable } from "./db/schema.js"
import { PROJECT_ID, type ModelKey } from "./platform.js"
import type { Secrets } from "./secrets.js"
import type { VmAddress } from "./vm/provider.js"
import { vmToken } from "./vm/provision.js"

export * as Keys from "./keys.js"

export type Keys = ReturnType<typeof make>

export type Credential = {
  id: string
  integrationID: string
  label: string
  value: unknown
  updatedAt: number
}

export type Step = { providerID: string; modelID: string; inputTokens: number; outputTokens: number; at: number }

/** What a VM holds in place of a secret: requests carrying it go through the gateway, which swaps in the real one. */
export const STAND_IN = "omai-gw."
export const standIn = (ref: string) => `${STAND_IN}${ref}`
// A stand-in sign-in never expires on the VM, so the VM never tries to refresh it; the control plane does.
const NEVER = 253_402_300_799_000

const Metadata = Schema.optional(Schema.Record(Schema.String, Schema.Unknown))
const KeyValue = Schema.Struct({ type: Schema.Literal("key"), key: Schema.String, metadata: Metadata })
const OAuthValue = Schema.Struct({
  type: Schema.Literal("oauth"),
  methodID: Schema.String,
  access: Schema.String,
  refresh: Schema.String,
  expires: Schema.Number,
  metadata: Metadata,
})
type OAuthValue = typeof OAuthValue.Type
const Exported = Schema.Array(
  Schema.Struct({
    id: Schema.String,
    integrationID: Schema.String,
    value: Schema.Union([KeyValue, OAuthValue]),
    hosts: Schema.Array(Schema.String),
    models: Schema.Array(Schema.Struct({ id: Schema.String })),
  }),
)
const decodeExported = Schema.decodeUnknownOption(Schema.fromJsonString(Exported))
const decodeHosts = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Array(Schema.String))),
)
const decodeOAuth = Schema.decodeUnknownOption(Schema.fromJsonString(OAuthValue))
const decodeValue = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))
const decodeStored = Schema.decodeUnknownOption(Schema.Union([KeyValue, OAuthValue]))

// The admin's providers change rarely; VMs ask every minute. Hosts change only with the catalog.
const CACHE_MS = 30_000
const HOSTS_CACHE_MS = 10 * 60_000
// A sign-in is refreshed when it has less than this left, like the integrations themselves do.
const REFRESH_MARGIN_MS = 5 * 60_000

/**
 * The model credentials of every VM: the admin's shared providers (from the platform server, only switched-on models)
 * and each owner's own credentials, which only that user's VMs can read or change. VMs get API keys of their owner, and
 * stand-ins for everything else; the gateway swaps a stand-in for the real secret, refreshing sign-ins here, in one
 * place. Usage reports from VMs land here too.
 */
export function make(deps: {
  db: Db
  config: Pick<Config, "signingKey">
  secrets: Secrets
  platform: { secret: string; address(): Promise<VmAddress>; models(): Promise<ModelKey[]> }
  now?: () => number
}) {
  const now = deps.now ?? (() => Date.now())
  const cache = { value: undefined as { at: number; value: typeof Exported.Type } | undefined }
  const hostsCache = { value: undefined as { at: number; value: Record<string, readonly string[]> } | undefined }
  const refreshing = new Map<string, Promise<OAuthValue | undefined>>()

  /** The platform server's providers; the last good list when it can't be asked, undefined before any. */
  async function exported() {
    if (cache.value && now() - cache.value.at < CACHE_MS) return cache.value.value
    const text = await platform("/api/experimental/platform/providers").catch(() => undefined)
    const decoded = text === undefined ? undefined : decodeExported(text)
    // Only a real answer is cached: a failure is tried again next time, and never mistaken for "no providers".
    if (decoded?._tag !== "Some") return cache.value?.value
    cache.value = { at: now(), value: decoded.value }
    return decoded.value
  }

  async function hosts(integrationID: string) {
    if (!hostsCache.value || now() - hostsCache.value.at >= HOSTS_CACHE_MS) {
      const text = await platform("/api/experimental/platform/hosts").catch(() => undefined)
      const decoded = text === undefined ? undefined : decodeHosts(text)
      if (decoded?._tag === "Some") hostsCache.value = { at: now(), value: decoded.value }
    }
    return hostsCache.value?.value[integrationID] ?? []
  }

  /** Calls the platform server with its secret; the text of a 2xx answer, else an error. */
  async function platform(path: string, init: { method?: string; body?: string } = {}) {
    // A slow platform server (still starting) must not hold up the VMs asking.
    const address = await Promise.race([
      deps.platform.address(),
      new Promise<undefined>((resolve) => setTimeout(resolve, 5_000)),
    ])
    if (!address) throw new Error("The platform server is not running")
    const token = vmToken(deps.config, {
      userID: "control-plane",
      projectID: PROJECT_ID,
      sessionID: "keys",
      host: address.host,
    })
    const res = await fetch(`${address.host}${path}`, {
      method: init.method ?? "GET",
      body: init.body,
      headers: {
        authorization: `Basic ${Buffer.from(`omai:${token}`).toString("base64")}`,
        "x-omai-platform-secret": deps.platform.secret,
        ...(init.body ? { "content-type": "application/json" } : {}),
      },
      signal: AbortSignal.timeout(30_000),
    })
    if (!res.ok) throw new Error(`The platform server answered ${res.status}`)
    return res.text()
  }

  async function owned(credentialID: string) {
    return (await deps.db.select().from(UserCredentialTable).where(eq(UserCredentialTable.id, credentialID)))[0]
  }

  /** A stored credential's value, or undefined when it can't be decrypted (another secrets key). */
  function open(row: typeof UserCredentialTable.$inferSelect) {
    const text = row.value ? deps.secrets.open(row.value) : undefined
    const value = text === undefined ? undefined : decodeValue(text)
    return value?._tag === "Some" ? value.value : undefined
  }

  /** A user's sign-in with time left, refreshed by the platform server once at a time; undefined when it can't be. */
  async function fresh(
    row: typeof UserCredentialTable.$inferSelect,
    value: OAuthValue,
  ): Promise<OAuthValue | undefined> {
    if (value.expires > now() + REFRESH_MARGIN_MS) return value
    const running = refreshing.get(row.id)
    if (running) return running
    const run = platform("/api/experimental/platform/refresh", {
      method: "POST",
      body: JSON.stringify({ integrationID: row.integration_id, value }),
    })
      .then(async (text) => {
        const decoded = decodeOAuth(text)
        if (decoded._tag !== "Some") return undefined
        await deps.db
          .update(UserCredentialTable)
          .set({ value: deps.secrets.seal(JSON.stringify(decoded.value)), updated_at: new Date(now()) })
          .where(eq(UserCredentialTable.id, row.id))
        return decoded.value
      })
      .catch((error: unknown) => {
        console.error(`refreshing sign-in ${row.id} failed`, error)
        return undefined
      })
      .finally(() => refreshing.delete(row.id))
    refreshing.set(row.id, run)
    return run
  }

  return {
    /**
     * Each shared provider with its switched-on models, and how it is connected, never the secret: a VM makes a
     * stand-in from it. Undefined while that isn't known yet.
     */
    async shared() {
      const providers = await exported()
      if (!providers) return undefined
      const switched = await deps.platform.models()
      return providers.flatMap((provider) => {
        const known = new Set(provider.models.map((model) => model.id))
        const models = switched
          .filter((item) => item.providerID === provider.id && known.has(item.modelID))
          .map((item) => item.modelID)
        if (models.length === 0) return []
        const value = provider.value
        return [
          {
            id: provider.id,
            integrationID: provider.integrationID,
            type: value.type,
            ...(value.type === "oauth" ? { methodID: value.methodID } : {}),
            ...(value.metadata ? { metadata: value.metadata } : {}),
            models,
          },
        ]
      })
    },

    /**
     * A user's credentials, deleted ones as tombstones so every VM removes its copy. API keys are sent as they are;
     * a sign-in is sent as a stand-in, so its tokens never leave the control plane.
     */
    async personal(userID: string) {
      const rows = await deps.db.select().from(UserCredentialTable).where(eq(UserCredentialTable.user_id, userID))
      return rows.flatMap((row) => {
        const base = { id: row.id, integrationID: row.integration_id, updatedAt: row.updated_at.getTime() }
        if (row.deleted_at || !row.value) return [{ ...base, label: "", value: null, deleted: true }]
        // One that can't be decrypted (another secrets key) is left out: sent empty, VMs would drop the real key.
        const value = open(row)
        if (value === undefined) return []
        const stored = decodeStored(value)
        const sent =
          stored._tag === "Some" && stored.value.type === "oauth"
            ? { ...stored.value, access: standIn(`u~${row.id}`), refresh: standIn(`u~${row.id}`), expires: NEVER }
            : value
        return [{ ...base, label: row.label, value: sent, deleted: false }]
      })
    },

    /** Stores a user's credential when it is newer than the stored one. A stand-in never replaces a real secret. */
    async put(userID: string, input: Credential): Promise<"ok" | "stale" | "forbidden"> {
      const existing = await owned(input.id)
      if (existing && existing.user_id !== userID) return "forbidden"
      if (JSON.stringify(input.value).includes(STAND_IN)) return "stale"
      if (existing && existing.updated_at.getTime() >= input.updatedAt) return "stale"
      const row = {
        integration_id: input.integrationID,
        label: input.label,
        value: deps.secrets.seal(JSON.stringify(input.value)),
        updated_at: new Date(input.updatedAt),
        deleted_at: null,
      }
      if (existing) {
        await deps.db.update(UserCredentialTable).set(row).where(eq(UserCredentialTable.id, input.id))
        return "ok"
      }
      await deps.db.insert(UserCredentialTable).values({ id: input.id, user_id: userID, ...row })
      return "ok"
    },

    /**
     * The real secret behind a stand-in, for the gateway, with the hosts it may be sent to. `s~<integration>` is a
     * shared provider (only while some of its models are switched on); `u~<credential>` is one of `userID`'s own.
     */
    async secret(userID: string, ref: string): Promise<{ secret: string; hosts: readonly string[] } | undefined> {
      if (ref.startsWith("s~")) {
        const integrationID = ref.slice(2)
        const shared = (await this.shared()) ?? []
        if (!shared.some((item) => item.integrationID === integrationID)) return undefined
        const matching = ((await exported()) ?? []).filter((item) => item.integrationID === integrationID)
        const value = matching[0]?.value
        if (!value) return undefined
        return {
          secret: value.type === "key" ? value.key : value.access,
          hosts: [...new Set(matching.flatMap((item) => item.hosts))],
        }
      }
      if (!ref.startsWith("u~")) return undefined
      const row = await owned(ref.slice(2))
      if (!row || row.user_id !== userID || row.deleted_at) return undefined
      const stored = decodeStored(open(row))
      if (stored._tag !== "Some") return undefined
      const value = stored.value.type === "oauth" ? await fresh(row, stored.value) : stored.value
      if (!value) return undefined
      return { secret: value.type === "key" ? value.key : value.access, hosts: await hosts(row.integration_id) }
    },

    /** Deletes a user's credential, keeping a tombstone with the time it happened. */
    async remove(userID: string, credentialID: string, at: number): Promise<"ok" | "stale" | "forbidden"> {
      const existing = await owned(credentialID)
      if (!existing) return "ok"
      if (existing.user_id !== userID) return "forbidden"
      if (existing.updated_at.getTime() >= at) return "stale"
      await deps.db
        .update(UserCredentialTable)
        .set({ value: null, label: "", updated_at: new Date(at), deleted_at: new Date(at) })
        .where(and(eq(UserCredentialTable.id, credentialID), eq(UserCredentialTable.user_id, userID)))
      return "ok"
    },

    /** Model usage a VM reported, one row per AI step. */
    async usage(userID: string, projectID: string, steps: readonly Step[]) {
      if (steps.length === 0) return
      await deps.db.insert(ModelUsageTable).values(
        steps.map((step) => ({
          id: crypto.randomUUID(),
          user_id: userID,
          project_id: projectID,
          provider_id: step.providerID,
          model_id: step.modelID,
          status: 200,
          input_tokens: step.inputTokens,
          output_tokens: step.outputTokens,
          bytes: 0,
          at: new Date(step.at),
        })),
      )
    },
  }
}
