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

const Exported = Schema.Array(
  Schema.Struct({
    id: Schema.String,
    key: Schema.String,
    models: Schema.Array(Schema.Struct({ id: Schema.String })),
  }),
)
const decodeExported = Schema.decodeUnknownOption(Schema.fromJsonString(Exported))
const decodeValue = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))

// The admin's providers change rarely; VMs ask every minute.
const CACHE_MS = 30_000

/**
 * The model keys a VM uses: the admin's shared providers (from the platform server, only switched-on models) and its
 * owner's personal credentials, which only that user's VMs can read or change. Usage reports from VMs land here too.
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

  /** The platform server's providers; the last good list when it can't be asked, undefined before any. */
  async function exported() {
    if (cache.value && now() - cache.value.at < CACHE_MS) return cache.value.value
    const fetched = await fetchExported().catch(() => undefined)
    // Only a real answer is cached: a failure is tried again next time, and never mistaken for "no providers".
    if (!fetched) return cache.value?.value
    cache.value = { at: now(), value: fetched }
    return fetched
  }

  async function fetchExported() {
    // A slow platform server (still starting) must not hold up the VMs asking.
    const address = await Promise.race([
      deps.platform.address(),
      new Promise<undefined>((resolve) => setTimeout(resolve, 5_000)),
    ])
    if (!address) return undefined
    const token = vmToken(deps.config, {
      userID: "control-plane",
      projectID: PROJECT_ID,
      sessionID: "keys",
      host: address.host,
    })
    const res = await fetch(`${address.host}/api/experimental/platform/providers`, {
      headers: {
        authorization: `Basic ${Buffer.from(`omai:${token}`).toString("base64")}`,
        "x-omai-platform-secret": deps.platform.secret,
      },
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) return undefined
    const decoded = decodeExported(await res.text())
    return decoded._tag === "Some" ? decoded.value : undefined
  }

  async function owned(credentialID: string) {
    return (await deps.db.select().from(UserCredentialTable).where(eq(UserCredentialTable.id, credentialID)))[0]
  }

  return {
    /** Each shared provider with its real key and switched-on models; undefined while that isn't known yet. */
    async shared() {
      const providers = await exported()
      if (!providers) return undefined
      const switched = await deps.platform.models()
      return providers.flatMap((provider) => {
        const known = new Set(provider.models.map((model) => model.id))
        const models = switched
          .filter((item) => item.providerID === provider.id && known.has(item.modelID))
          .map((item) => item.modelID)
        return models.length > 0 ? [{ id: provider.id, key: provider.key, models }] : []
      })
    },

    /** A user's credentials, deleted ones as tombstones so every VM removes its copy. */
    async personal(userID: string) {
      const rows = await deps.db.select().from(UserCredentialTable).where(eq(UserCredentialTable.user_id, userID))
      return rows.flatMap((row) => {
        const base = { id: row.id, integrationID: row.integration_id, updatedAt: row.updated_at.getTime() }
        if (row.deleted_at || !row.value) return [{ ...base, label: "", value: null, deleted: true }]
        // One that can't be decrypted (another secrets key) is left out: sent empty, VMs would drop the real key.
        const text = deps.secrets.open(row.value)
        const value = text === undefined ? undefined : decodeValue(text)
        if (value?._tag !== "Some") return []
        return [{ ...base, label: row.label, value: value.value, deleted: false }]
      })
    },

    /** Stores a user's credential when it is newer than the stored one. */
    async put(userID: string, input: Credential): Promise<"ok" | "stale" | "forbidden"> {
      const existing = await owned(input.id)
      if (existing && existing.user_id !== userID) return "forbidden"
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
