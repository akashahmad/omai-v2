import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { ControlPlaneConfig } from "../src/config.js"
import { NorthflankVmProvider } from "../src/vm/northflank.js"
import { fakeNorthflank } from "./fixture/fake-northflank.js"

let fake: Awaited<ReturnType<typeof fakeNorthflank>>
beforeAll(async () => {
  fake = await fakeNorthflank()
})
afterAll(() => fake.close())
beforeEach(() => fake.reset())

const base = {
  OMAI_APP_ORIGIN: "https://app.omai.test",
  OMAI_TOKEN_SIGNING_KEY: "private",
  OMAI_TOKEN_PUBLIC_KEY: "public",
  OMAI_ROUTER_URL: "https://router.omai.test",
  OMAI_VM_PROVIDER: "northflank",
  OMAI_NORTHFLANK_API_TOKEN: "nf-token",
  OMAI_NORTHFLANK_PROJECT: "omaiv2",
  OMAI_NORTHFLANK_IMAGE: "docker.io/someone/omai-vm",
  OMAI_NORTHFLANK_PLAN: "nf-compute-50",
  OMAI_NORTHFLANK_VOLUME_SIZE_GB: "2",
  OMAI_CONTROL_PLANE_VM_URL: "http://controlplane:4101",
}

function provider(env: Record<string, string> = {}) {
  const config = ControlPlaneConfig.fromEnv({ ...base, OMAI_NORTHFLANK_API_BASE: fake.apiBase, ...env })
  return { config, provider: NorthflankVmProvider.make(config) }
}

const PROJECT = "0b6f1c2e-6a3c-4d0e-9a54-1f2e3d4c5b6a"
const spec = (projectID = PROJECT) => ({
  projectID,
  slug: "shop",
  env: {
    OMAI_PROJECT_ID: projectID,
    OMAI_PROJECT_SLUG: "shop",
    OMAI_PROJECT_TOKEN: "project-token",
    OMAI_CONTROL_PLANE_URL: "http://controlplane:4101",
    OMAI_TOKEN_PUBLIC_KEY: "public",
  },
})

const calls = () => fake.state.requests.map((request) => `${request.method} ${request.path.replace("/v1/projects/omaiv2", "")}`)

describe("NorthflankVmProvider", () => {
  test("create makes the volume and service, attaches, then scales to one", async () => {
    const p = provider()
    const address = await p.provider.create(spec())
    const service = [...fake.state.services.values()][0]!
    const volume = [...fake.state.volumes.values()][0]!
    expect(service.name).toBe(`omai-vm-${PROJECT.replace(/-/g, "")}`)
    expect(volume.name.startsWith("omai-vol-")).toBe(true)
    expect(volume.name.length).toBeLessThanOrEqual(39)
    expect(volume.mount).toBe("/home/omai")
    expect(volume.size).toBe(6 * 1024)
    expect(service.image).toBe("docker.io/someone/omai-vm:latest")
    expect(service.plan).toBe("nf-compute-50")
    expect(service.description).toBe(`project: ${PROJECT}`)
    expect(service.ports.map((port) => [port.name, port.internalPort, port.public])).toEqual([
      ["api", 4096, false],
      ["preview", 4097, true],
    ])
    expect(service.instances).toBe(1)
    expect(volume.attachedTo).toBe(service.id)
    const order = calls().filter((call) => /^(POST|PATCH)/.test(call))
    expect(order.indexOf("POST /services/deployment")).toBeLessThan(order.indexOf(`POST /volumes/${volume.id}/attach`))
    expect(order.indexOf(`POST /volumes/${volume.id}/attach`)).toBeLessThan(
      order.indexOf(`PATCH /services/deployment/${service.id}`),
    )
    expect(address).toEqual({
      vmID: service.id,
      host: `http://${service.id}:4096`,
      home: "/home/omai",
      preview: `https://preview--${service.id}--abcdefghijkl.code.run`,
    })
  })

  test("a service hidden right after create is retried, not failed", async () => {
    const p = provider()
    fake.state.hideNew = 3
    const address = await p.provider.create(spec())
    expect(address.vmID).toBe(`omai-vm-${PROJECT.replace(/-/g, "")}`)
    expect([...fake.state.services.values()][0]!.instances).toBe(1)
    expect([...fake.state.volumes.values()][0]!.attachedTo).toBe(address.vmID)
  })

  test("a racing create adopts the existing service", async () => {
    const p = provider()
    fake.state.raceNextCreate = true
    const address = await p.provider.create(spec())
    expect(fake.state.services.size).toBe(1)
    expect(address.vmID).toBe(`omai-vm-${PROJECT.replace(/-/g, "")}`)
    // Created again (a retried project): the same service and volume, with the new token.
    const again = await p.provider.create({ ...spec(), env: { ...spec().env, OMAI_PROJECT_TOKEN: "new-token" } })
    expect(again.vmID).toBe(address.vmID)
    expect(fake.state.services.size).toBe(1)
    expect(fake.state.volumes.size).toBe(1)
    expect([...fake.state.services.values()][0]!.env.OMAI_PROJECT_TOKEN).toBe("new-token")
  })

  test("the VM environment holds only the allowed variables", async () => {
    const p = provider()
    await p.provider.create({
      ...spec(),
      env: { ...spec().env, OMAI_TOKEN_SIGNING_KEY: "never", OMAI_CLOUDFLARE_API_TOKEN: "never" },
    })
    expect(Object.keys([...fake.state.services.values()][0]!.env).sort()).toEqual([
      "OMAI_APP_ORIGIN",
      "OMAI_CONTROL_PLANE_URL",
      "OMAI_PREVIEW_PORT",
      "OMAI_PREVIEW_PUBLIC",
      "OMAI_PROJECTS_HOME",
      "OMAI_PROJECT_ID",
      "OMAI_PROJECT_SLUG",
      "OMAI_PROJECT_TOKEN",
      "OMAI_TOKEN_PUBLIC_KEY",
    ])
    expect([...fake.state.services.values()][0]!.env.OMAI_APP_ORIGIN).toBe("https://app.omai.test")
    // The server knows it serves a project (and where its folder lives) only from this.
    expect([...fake.state.services.values()][0]!.env.OMAI_PROJECTS_HOME).toBe("/home/omai")
    // Anyone with the preview link sees it while the VM runs, as the owner chose.
    expect([...fake.state.services.values()][0]!.env.OMAI_PREVIEW_PUBLIC).toBe("1")
  })

  test("opening a running VM twice costs no API call the second time", async () => {
    const p = provider()
    const created = await p.provider.create(spec())
    await p.provider.stop(created.vmID)
    expect([...fake.state.services.values()][0]!.paused).toBe(true)
    const resumed = await p.provider.ensureRunning(created.vmID)
    expect(resumed).toEqual(created)
    expect([...fake.state.services.values()][0]!.paused).toBe(false)
    const before = fake.state.requests.length
    expect(await p.provider.ensureRunning(created.vmID)).toEqual(created)
    expect(fake.state.requests.length).toBe(before)
    // Stopping twice is fine.
    await p.provider.stop(created.vmID)
    await p.provider.stop(created.vmID)
  })

  test("list and stop ignore services without our prefix", async () => {
    const p = provider()
    const ours = await p.provider.create(spec())
    // Someone else's services in the same project, running, with names close to ours.
    for (const name of ["omai-vm", "vm-other", "omai-vmx-1", "omai-e2e-vm-1", "notomai-vm-1"])
      fake.state.services.set(name, {
        id: name,
        project: "omaiv2",
        name,
        instances: 1,
        paused: false,
        env: {},
        ports: [],
        volumes: [],
        hiddenFor: 0,
      })
    expect(await p.provider.list()).toEqual([ours.vmID])
    for (const name of ["omai-vm", "vm-other", "omai-e2e-vm-1"]) {
      await expect(p.provider.stop(name)).rejects.toThrow()
      await expect(p.provider.ensureRunning(name)).rejects.toThrow()
    }
    expect([...fake.state.services.values()].filter((item) => item.paused)).toEqual([])
    expect(fake.state.requests.some((request) => /omai-e2e-vm-1|vm-other/.test(request.path))).toBe(false)
    await p.provider.stop(ours.vmID)
    expect(await p.provider.list()).toEqual([])
  })

  test("public VMs expose the api port and use its public address", async () => {
    const p = provider({ OMAI_APP_ORIGIN: "http://localhost:4455", OMAI_NORTHFLANK_PUBLIC_VMS: "true" })
    const address = await p.provider.create(spec())
    expect(address.host).toBe(`https://api--${address.vmID}--abcdefghijkl.code.run`)
  })

  test("public VMs are refused outside localhost", () => {
    expect(() => provider({ OMAI_NORTHFLANK_PUBLIC_VMS: "true" })).toThrow(/OMAI_NORTHFLANK_PUBLIC_VMS/)
    expect(() =>
      provider({ OMAI_APP_ORIGIN: "http://127.0.0.1:4455", OMAI_NORTHFLANK_PUBLIC_VMS: "true" }),
    ).not.toThrow()
  })

  test("project omai is refused", () => {
    expect(() => provider({ OMAI_NORTHFLANK_PROJECT: "omai" })).toThrow(/omai/)
    expect(() => provider({ OMAI_NORTHFLANK_PROJECT: "OMAI" })).toThrow(/omai/)
  })

  // Loopback, the local default, is never the control plane from inside a Northflank VM.
  test("Northflank VMs need the control plane's address for them", () => {
    expect(() => provider({ OMAI_CONTROL_PLANE_VM_URL: "" })).toThrow(/OMAI_CONTROL_PLANE_VM_URL/)
    expect(() =>
      provider({ OMAI_CONTROL_PLANE_VM_URL: "", OMAI_APP_ORIGIN: "http://localhost:4455", OMAI_NORTHFLANK_PUBLIC_VMS: "true" }),
    ).not.toThrow()
  })

  test("the longest prefix still fits the preview port's address", async () => {
    const p = provider({ OMAI_NORTHFLANK_NAME_PREFIX: "omai-e2e-xyz" })
    const address = await p.provider.create(spec())
    expect(address.vmID.startsWith("omai-e2e-xyz-vm-")).toBe(true)
    expect(address.preview).toBeDefined()
  })

  test("missing Northflank variables are named", () => {
    expect(() => provider({ OMAI_NORTHFLANK_IMAGE: "" })).toThrow(/OMAI_NORTHFLANK_IMAGE/)
    expect(() => provider({ OMAI_NORTHFLANK_NAME_PREFIX: "a-very-long-prefix" })).toThrow(/OMAI_NORTHFLANK_NAME_PREFIX/)
  })
})
