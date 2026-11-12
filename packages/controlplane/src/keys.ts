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

/**
 * The refresh token a VM holds for a sign-in: the real one stays here, so a sign-in is refreshed in one place. Several
 * VMs refreshing one sign-in themselves would rotate its refresh token out from under each other.
 */
export const MANAGED_REFRESH = "omai-managed"
// What VMs on images before direct calls held in place of a secret; never stored over a real one.
const LEGACY_STAND_IN = "omai-gw."

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
type KeyValue = typeof KeyValue.Type
const Exported = Schema.Array(
  Schema.Struct({
    id: Schema.String,
    integrationID: Schema.String,
    value: Schema.Union([KeyValue, OAuthValue]),
    models: Schema.Array(Schema.Struct({ id: Schema.String })),
  }),
)
const decodeExported = Schema.decodeUnknownOption(Schema.fromJsonString(Exported))
const decodeOAuth = Schema.decodeUnknownOption(Schema.fromJsonString(OAuthValue))
const decodeValue = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))
const decodeStored = Schema.decodeUnknownOption(Schema.Union([KeyValue, OAuthValue]))

// The admin's providers change rarely; VMs ask every minute.
const CACHE_MS = 30_000
// A sign-in is refreshed when it has less than this left, like the integrations themselves do.
const REFRESH_MARGIN_MS = 5 * 60_000

/**
 * The model credentials of every VM: the admin's shared providers (from the platform server, only switched-on models)
 * and each owner's own credentials, which only that user's VMs can read or change. VMs get the real keys and access
 * tokens and call providers directly; refresh tokens stay here, and sign-ins are refreshed here, in one place. Usage
 * reports from VMs land here too.
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
  const refreshing = new Map<string, Promise<OAuthValue | undefined>>()

  /** The platform server's providers; the last good list when it can't be asked, undefined before any. */
  async function exported(force = false) {
    if (!force && cache.value && now() - cache.value.at < CACHE_MS) return cache.value.value
    const text = await platform("/api/experimental/platform/providers").catch(() => undefined)
    const decoded = text === undefined ? undefined : decodeExported(text)
    // Only a real answer is cached: a failure is tried again next time, and never mistaken for "no providers".
    if (decoded?._tag !== "Some") return cache.value?.value
    cache.value = { at: now(), value: decoded.value }
    return decoded.value
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

  /** A credential as a VM gets it: a sign-in carries the managed refresh token, never the real one. */
  function managed<T extends KeyValue | OAuthValue>(value: T): T {
    return value.type === "oauth" ? { ...value, refresh: MANAGED_REFRESH } : value
  }

  return {
    /**
     * Each shared provider with its switched-on models and its credential, a sign-in with the managed refresh token.
     * Undefined while that isn't known yet.
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
        return [{ id: provider.id, integrationID: provider.integrationID, value: managed(provider.value), models }]
      })
    },

    /**
     * A user's credentials, deleted ones as tombstones so every VM removes its copy. API keys are sent as they are; a
     * sign-in with time left (refreshed here when needed) and the managed refresh token.
     */
    async personal(userID: string) {
      const rows = await deps.db.select().from(UserCredentialTable).where(eq(UserCredentialTable.user_id, userID))
      const items = await Promise.all(
        rows.map(async (row) => {
          const base = { id: row.id, integrationID: row.integration_id, updatedAt: row.updated_at.getTime() }
          if (row.deleted_at || !row.value) return [{ ...base, label: "", value: null as unknown, deleted: true }]
          // One that can't be decrypted (another secrets key) is left out: sent empty, VMs would drop the real key.
          const value = open(row)
          if (value === undefined) return []
          const stored = decodeStored(value)
          if (stored._tag === "None" || stored.value.type !== "oauth")
            return [{ ...base, label: row.label, value, deleted: false }]
          // One that can't be refreshed now is left out too: VMs keep their copy and get it on a later pull.
          const current = await fresh(row, stored.value)
          if (!current) return []
          return [{ ...base, label: row.label, value: managed(current) as unknown, deleted: false }]
        }),
      )
      return items.flat()
    },

    /**
     * Stores a user's credential when it is newer than the stored one. A sign-in sent with the managed refresh token
     * keeps the stored refresh token, and is refused when there is none to keep.
     */
    async put(userID: string, input: Credential): Promise<"ok" | "stale" | "forbidden"> {
      const existing = await owned(input.id)
      if (existing && existing.user_id !== userID) return "forbidden"
      if (JSON.stringify(input.value).includes(LEGACY_STAND_IN)) return "stale"
      if (existing && existing.updated_at.getTime() >= input.updatedAt) return "stale"
      const sent = decodeStored(input.value)
      const managedSignIn =
        sent._tag === "Some" && sent.value.type === "oauth" && sent.value.refresh === MANAGED_REFRESH
      const kept = managedSignIn && existing && !existing.deleted_at ? decodeStored(open(existing)) : undefined
      const refresh = kept?._tag === "Some" && kept.value.type === "oauth" ? kept.value.refresh : undefined
      if (managedSignIn && !refresh) return "stale"
      const value = sent._tag === "Some" && refresh ? { ...sent.value, refresh } : input.value
      const row = {
        integration_id: input.integrationID,
        label: input.label,
        value: deps.secrets.seal(JSON.stringify(value)),
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
     * A sign-in with time left for one of `userID`'s VMs, refreshed here once for every caller. `s~<integration>` is a
     * shared provider (only while some of its models are switched on); `u~<credential>` is one of `userID`'s own.
     * Undefined when it is unknown, not theirs, or can't be refreshed now.
     */
    async refresh(userID: string, ref: string): Promise<{ access: string; expires: number } | undefined> {
      if (ref.startsWith("s~")) {
        const integrationID = ref.slice(2)
        const find = async () =>
          ((await this.shared()) ?? []).find((item) => item.integrationID === integrationID)?.value
        const cached = await find()
        if (cached?.type !== "oauth") return undefined
        if (cached.expires > now() + REFRESH_MARGIN_MS) return { access: cached.access, expires: cached.expires }
        // The platform server refreshes its sign-ins as it exports them, so asking it again gives a fresh one.
        await exported(true)
        const value = await find()
        return value?.type === "oauth" ? { access: value.access, expires: value.expires } : undefined
      }
      if (!ref.startsWith("u~")) return undefined
      const row = await owned(ref.slice(2))
      if (!row || row.user_id !== userID || row.deleted_at) return undefined
      const stored = decodeStored(open(row))
      if (stored._tag !== "Some" || stored.value.type !== "oauth") return undefined
      const value = await fresh(row, stored.value)
      return value ? { access: value.access, expires: value.expires } : undefined
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
