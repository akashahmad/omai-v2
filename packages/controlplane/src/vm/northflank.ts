import type { Config } from "../config.js"
import { NorthflankClient, NorthflankError } from "./northflank-client.js"
import type { VmAddress, VmProvider, VmSpec } from "./provider.js"

export * as NorthflankVmProvider from "./northflank.js"

const API_PORT = 4096
const HOME = "/home/omai"
// Only these reach a VM; anything else a caller passes is dropped, so no platform secret can slip in.
const ALLOWED_ENV = new Set([
  "OMAI_PROJECT_ID",
  "OMAI_PROJECT_SLUG",
  "OMAI_PROJECT_TOKEN",
  "OMAI_CONTROL_PLANE_URL",
  "OMAI_TOKEN_PUBLIC_KEY",
])
// Northflank's API is eventually consistent: a service it just created can answer 404 to the next calls naming it.
// The old project saw one hidden for over 26 s, so the window is generous.
const SETTLE_MS = 90_000
const SETTLE_RETRY_MS = 500
// Reconcile asks `list` for every project in turn; one answer serves them all for this long.
const LIST_TTL_MS = 15_000

/**
 * Project VMs as Northflank services in one project, each with its own volume at `/home/omai`. It only ever acts on
 * services and volumes named with its prefix (`<prefix>-vm-…`, `<prefix>-vol-…`) and never deletes anything: a paused
 * VM keeps its volume, and a person deletes by hand.
 */
export function make(
  config: Pick<Config, "appOrigin" | "previewPort"> & { northflank?: Config["northflank"] },
  client?: NorthflankClient.Client,
) {
  const nf = config.northflank
  if (!nf) throw new Error("The Northflank provider needs the OMAI_NORTHFLANK_* configuration")
  const api = client ?? NorthflankClient.make({ apiBase: nf.apiBase, token: nf.token, project: nf.project })
  const servicePrefix = `${nf.prefix}-vm-`
  const image = /[:@][^/:@]*$/.test(nf.image) ? nf.image : `${nf.image}:latest`
  // The rate limit is shared by the whole team: a VM known to run costs no call to open, and a port's address is
  // fixed for the life of its service.
  const running = new Map<string, VmAddress>()
  const listed: { at: number; ids?: Promise<string[]> } = { at: 0 }

  // A public port's address is `<port>--<service>--<12-character namespace>.code.run`, and its first label is at most 63
  // characters: with the `preview` port that leaves 40 for the name, the whole project ID without dashes for prefix `omai`.
  const serviceName = (projectID: string) => `${servicePrefix}${slug(projectID).replace(/-/g, "")}`.slice(0, 40)
  const volumeName = (projectID: string) => `${nf.prefix}-vol-${slug(projectID).replace(/-/g, "")}`.slice(0, 39)
  const ours = (vmID: string) => {
    if (!vmID.startsWith(servicePrefix)) throw new Error(`Not a VM of this control plane: ${vmID}`)
  }

  async function address(vmID: string): Promise<VmAddress> {
    const ports = await settle(() => api.getPorts(vmID))
    const dns = (name: string) => ports.find((port) => port.name === name && port.public && port.dns)?.dns
    const apiDns = dns("api")
    if (nf!.publicVms && !apiDns) throw new Error(`The VM ${vmID} has no public api port`)
    const preview = dns("preview")
    return {
      vmID,
      // Inside the project, services answer at `<service>:<port>` over plain HTTP.
      host: nf!.publicVms ? `https://${apiDns}` : `http://${vmID}:${API_PORT}`,
      home: HOME,
      ...(preview ? { preview: `https://${preview}` } : {}),
    }
  }

  async function ensureService(spec: VmSpec, env: Record<string, string>) {
    const name = serviceName(spec.projectID)
    const found = (await api.listServices()).find((item) => item.name === name)
    if (found) {
      // A retried create brings a new project token.
      await settle(() => api.setRuntimeEnvironment(found.id, env))
      return { id: found.id, created: false }
    }
    return api
      .createService({
        name,
        description: describe(`project: ${spec.projectID}`),
        billing: { deploymentPlan: nf!.plan },
        // No instances yet: attaching a volume to a running service restarts it, a whole extra boot.
        deployment: { instances: 0, external: { imagePath: image }, docker: { configType: "default" } },
        ports: [
          { name: "api", internalPort: API_PORT, public: nf!.publicVms, protocol: "HTTP" },
          { name: "preview", internalPort: config.previewPort, public: true, protocol: "HTTP" },
        ],
        runtimeEnvironment: env,
      })
      .then((created) => ({ id: created.id, created: true }))
      .catch(async (error: unknown) => {
        // Two creates raced (a retried job): adopt the winner's service.
        if (!(error instanceof NorthflankError) || error.status !== 409) throw error
        const raced = (await api.listServices()).find((item) => item.name === name)
        if (!raced) throw error
        await settle(() => api.setRuntimeEnvironment(raced.id, env))
        return { id: raced.id, created: false }
      })
  }

  async function ensureVolume(projectID: string) {
    const name = volumeName(projectID)
    const found = (await api.listVolumes()).find((item) => item.name === name)
    if (found) return found.id
    return api
      .createVolume({
        name,
        mounts: [{ containerMountPath: HOME }],
        spec: { accessMode: "ReadWriteOnce", storageSize: nf!.volumeSizeGb * 1024 },
      })
      .then((created) => created.id)
      .catch(async (error: unknown) => {
        if (!(error instanceof NorthflankError) || error.status !== 409) throw error
        const raced = (await api.listVolumes()).find((item) => item.name === name)
        if (!raced) throw error
        return raced.id
      })
  }

  /** Resumes and scales to one; a service already running answers 400 or 409, which is fine. */
  async function start(vmID: string) {
    await settle(() => api.resumeService(vmID)).catch(already)
    // A create interrupted before it scaled leaves a service at zero instances that resume alone never boots.
    await settle(() => api.scaleService(vmID, 1)).catch(already)
  }

  return {
    async create(spec: VmSpec) {
      const env = {
        ...Object.fromEntries(Object.entries(spec.env).filter(([key]) => ALLOWED_ENV.has(key))),
        OMAI_APP_ORIGIN: config.appOrigin,
        OMAI_PREVIEW_PORT: String(config.previewPort),
        // The volume: the server serves the project at `<home>/<slug>` only when this is set.
        OMAI_PROJECTS_HOME: HOME,
      }
      const service = await ensureService(spec, env)
      const volumeID = await ensureVolume(spec.projectID)
      await settle(() => api.attachVolume(volumeID, service.id)).catch((error: unknown) => {
        // Already attached: a create run again.
        if (!(error instanceof NorthflankError) || error.status !== 409) throw error
      })
      if (service.created) await settle(() => api.scaleService(service.id, 1))
      if (!service.created) await start(service.id)
      const result = await address(service.id)
      running.set(service.id, result)
      listed.at = 0
      return result
    },

    async ensureRunning(vmID: string) {
      ours(vmID)
      const known = running.get(vmID)
      if (known) return known
      await start(vmID)
      const result = await address(vmID)
      running.set(vmID, result)
      listed.at = 0
      return result
    },

    async stop(vmID: string) {
      ours(vmID)
      running.delete(vmID)
      listed.at = 0
      await api.pauseService(vmID).catch(already)
    },

    async list() {
      if (!listed.ids || Date.now() - listed.at >= LIST_TTL_MS) {
        listed.at = Date.now()
        listed.ids = runningServices().catch((error: unknown) => {
          listed.at = 0
          throw error
        })
      }
      const ids = await listed.ids
      // A VM paused elsewhere must be resumed on its next open, not handed out from the cache.
      for (const vmID of running.keys()) if (!ids.includes(vmID)) running.delete(vmID)
      return ids
    },

    async close() {},
  } satisfies VmProvider & { close(): Promise<void> }

  async function runningServices() {
    const services = (await api.listServices()).filter((item) => item.name.startsWith(servicePrefix))
    const details = await Promise.all(services.map((item) => api.getService(item.id)))
    return details
      .filter((item) => !item.servicePaused && (item.deployment?.instances ?? 0) > 0)
      .map((item) => item.id)
  }
}

function already(error: unknown) {
  if (error instanceof NorthflankError && (error.status === 400 || error.status === 409)) return
  throw error
}

function settle<A>(call: () => Promise<A>, until = Date.now() + SETTLE_MS): Promise<A> {
  return call().catch(async (error: unknown) => {
    if (!(error instanceof NorthflankError) || error.status !== 404 || Date.now() >= until) throw error
    await new Promise((resolve) => setTimeout(resolve, SETTLE_RETRY_MS))
    return settle(call, until)
  })
}

function slug(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
}

// Northflank refuses a description over 200 characters or with anything outside this set, failing the whole create.
const DESCRIPTION_DISALLOWED = /[^a-zA-Z0-9.,?\s\\/'"()[\];`%^&*\-_:!]/g

function describe(text: string) {
  const cleaned = text.replace(DESCRIPTION_DISALLOWED, "-")
  return cleaned.length <= 200 ? cleaned : `${cleaned.slice(0, 197)}...`
}
