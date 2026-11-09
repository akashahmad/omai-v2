import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { LocalVmProvider } from "../src/vm/local.js"
import { fakeVmCommand, testConfig, until } from "./fixture/setup.js"

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((fn) => fn()))
})

async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), "omai-vm-"))
  const config = testConfig({ OMAI_LOCAL_PROJECTS_ROOT: root, OMAI_LOCAL_SERVE_COMMAND: fakeVmCommand })
  const make = () => {
    const provider = LocalVmProvider.make(config)
    cleanup.push(() => provider.close())
    return provider
  }
  return { make, root }
}

const spec = (projectID: string) => ({ projectID, slug: "app", env: {} })

const answers = (host: string) =>
  fetch(`${host}/api/info`, { signal: AbortSignal.timeout(1000) }).then(
    (res) => res.ok,
    () => false,
  )

describe("LocalVmProvider", () => {
  test("stop then ensureRunning answers at the same host", async () => {
    const provider = (await setup()).make()
    const created = await provider.create(spec("p1"))
    await until(() => answers(created.host), Boolean)
    await provider.stop("p1")
    expect(await answers(created.host)).toBe(false)
    const resumed = await provider.ensureRunning("p1")
    expect(resumed.host).toBe(created.host)
    await until(() => answers(resumed.host), Boolean)
  })

  test("stop is idempotent", async () => {
    const provider = (await setup()).make()
    await provider.create(spec("p1"))
    await provider.stop("p1")
    await provider.stop("p1")
    await provider.stop("unknown")
    expect(await provider.list()).toEqual([])
  })

  test("list shows only running VMs", async () => {
    const provider = (await setup()).make()
    await provider.create(spec("p1"))
    await provider.create(spec("p2"))
    await provider.stop("p1")
    expect(await provider.list()).toEqual(["p2"])
  })

  test("same port after a new provider instance", async () => {
    const env = await setup()
    const first = env.make()
    const created = await first.create(spec("p1"))
    await first.close()
    const resumed = await env.make().ensureRunning("p1")
    expect(resumed.host).toBe(created.host)
    await until(() => answers(resumed.host), Boolean)
  })

  test("a spec saved before ports were kept gets one and keeps it", async () => {
    const env = await setup()
    const first = env.make()
    await first.create(spec("p1"))
    await first.close()
    const file = path.join(env.root, "p1", "spec.json")
    await writeFile(file, JSON.stringify(spec("p1")))
    const resumed = await env.make().ensureRunning("p1")
    expect(JSON.parse(await readFile(file, "utf8")).port).toBe(Number(new URL(resumed.host).port))
  })

  test("a server left running by a control plane that crashed is replaced", async () => {
    const env = await setup()
    const crashed = env.make()
    const created = await crashed.create(spec("p1"))
    await until(() => answers(created.host), Boolean)
    // No close(): the old control plane died without stopping its servers.
    const resumed = await env.make().ensureRunning("p1")
    expect(resumed.host).toBe(created.host)
    await until(() => answers(resumed.host), Boolean)
  })

  test("starting the same VM twice at once starts one process", async () => {
    const env = await setup()
    const first = env.make()
    await first.create(spec("p1"))
    await first.stop("p1")
    const [a, b] = await Promise.all([first.ensureRunning("p1"), first.ensureRunning("p1")])
    expect(a.host).toBe(b.host)
    await until(() => answers(a.host), Boolean)
    expect(await first.list()).toEqual(["p1"])
    // A second process on the same port would have died; the one we have still answers after a moment.
    await Bun.sleep(300)
    expect(await answers(a.host)).toBe(true)
  })
})
