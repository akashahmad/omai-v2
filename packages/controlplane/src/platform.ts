import { randomBytes } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import type { Config } from "./config.js"
import type { Db } from "./db/database.js"
import { PlatformModelTable } from "./db/schema.js"
import { LocalVmProvider } from "./vm/local.js"
import type { VmAddress } from "./vm/provider.js"
import { vmToken, waitReady } from "./vm/provision.js"

export * as Platform from "./platform.js"

export type Platform = Awaited<ReturnType<typeof make>>

export type ModelKey = { providerID: string; modelID: string }

/** The reserved project ID of the platform server; never a real project's (those are UUIDs). */
export const PROJECT_ID = "platform"

/**
 * The platform server: a private O M A I + server, only for platform settings. Admins connect providers on it from
 * Settings > Shared providers, so the admin's keys are kept here and handed to project VMs by the control plane. It holds the platform
 * secret, which the control plane sends to read those keys for VMs, and nothing that would make it a project.
 */
export async function make(deps: { db: Db; config: Config; now?: () => number }) {
  const config = deps.config
  const secret = await loadSecret(config.dataDir)
  const provider = LocalVmProvider.make({ ...config, localProjectsRoot: path.join(config.dataDir, "platform"),
    fixedUrl: config.platformUrl,
  })
  const spec = {
    projectID: PROJECT_ID,
    slug: PROJECT_ID,
    env: { OMAI_PROJECT_ID: PROJECT_ID, OMAI_TOKEN_PUBLIC_KEY: config.publicKey, OMAI_PLATFORM_SECRET: secret },
  }
  // Created once (saving its spec, port and secret), then started from that spec, so it keeps its port and data.
  const created = { done: undefined as Promise<VmAddress> | undefined }

  async function running() {
    if (!created.done) {
      created.done = provider.create(spec)
      return created.done
    }
    await created.done.catch(() => undefined)
    return provider.ensureRunning(PROJECT_ID)
  }

  return {
    secret,

    /** The server's address once it answers. */
    async address() {
      const address = await running()
      await waitReady(config, { userID: "control-plane", projectID: PROJECT_ID, host: address.host })
      return address
    },

    /** Its address and a VM token for an admin's settings pages, like opening a project. */
    async open(userID: string, sessionID: string) {
      const address = await running()
      await waitReady(config, { userID, projectID: PROJECT_ID, host: address.host })
      return {
        routerUrl: `${config.routerUrl}/vm/${PROJECT_ID}`,
        token: vmToken(config, { userID, projectID: PROJECT_ID, sessionID, host: address.host }, deps.now?.()),
        directory: address.home,
      }
    },

    /** The models switched on for every user. */
    async models(): Promise<ModelKey[]> {
      const rows = await deps.db
        .select({ providerID: PlatformModelTable.provider_id, modelID: PlatformModelTable.model_id })
        .from(PlatformModelTable)
      return rows.toSorted((a, b) => `${a.providerID}/${a.modelID}`.localeCompare(`${b.providerID}/${b.modelID}`))
    },

    /** Replaces the switched-on models with `list`. */
    async setModels(list: readonly ModelKey[]) {
      const unique = [...new Map(list.map((item) => [`${item.providerID}/${item.modelID}`, item])).values()]
      await deps.db.transaction(async (tx) => {
        await tx.delete(PlatformModelTable)
        if (unique.length > 0)
          await tx
            .insert(PlatformModelTable)
            .values(unique.map((item) => ({ provider_id: item.providerID, model_id: item.modelID })))
      })
    },

    close: () => provider.close(),
  }
}

async function loadSecret(dataDir: string) {
  const file = path.join(dataDir, "platform-secret")
  const saved = (await readFile(file, "utf8").catch(() => "")).trim()
  if (saved) return saved
  const secret = randomBytes(32).toString("base64url")
  await mkdir(dataDir, { recursive: true })
  await writeFile(file, secret, { mode: 0o600 })
  return secret
}
