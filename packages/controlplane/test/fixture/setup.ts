import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { SignedToken } from "@opencode/util/signed-token"
import { ControlPlaneConfig } from "../../src/config.js"
import { Database } from "../../src/db/database.js"
import { Projects } from "../../src/projects.js"
import { Users } from "../../src/users.js"
import { LocalVmProvider } from "../../src/vm/local.js"
import type { VmProvider } from "../../src/vm/provider.js"

const keys = SignedToken.generateKeyPair()

export function testConfig(env: Record<string, string> = {}) {
  return ControlPlaneConfig.fromEnv({
    OMAI_APP_ORIGIN: "http://app.test",
    OMAI_TOKEN_SIGNING_KEY: keys.privateKeyPem,
    OMAI_TOKEN_PUBLIC_KEY: keys.publicKeyPem,
    OMAI_ROUTER_URL: "http://router.test",
    ...env,
  })
}

export function clock(start = Date.parse("2026-11-06T10:00:00Z")) {
  const state = { now: start }
  return { now: () => state.now, advance: (ms: number) => void (state.now += ms) }
}

export const fakeVmCommand = JSON.stringify(["bun", new URL("./fake-vm-server.ts", import.meta.url).pathname])
export const exitingVmCommand = JSON.stringify(["bun", new URL("./exit.ts", import.meta.url).pathname])

export async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, timeoutMs = 5000) {
  const start = Date.now()
  for (;;) {
    const value = await read()
    if (done(value)) return value
    if (Date.now() - start > timeoutMs) throw new Error(`timed out; last value ${JSON.stringify(value)}`)
    await Bun.sleep(50)
  }
}

/** A control plane's pieces over an in-memory database and fake VMs, with two users and a settable clock. */
export async function harness(
  env: Record<string, string> = {},
  /** Wraps the local provider, as to add what a real one returns. */
  wrap: (provider: VmProvider) => VmProvider = (provider) => provider,
) {
  const root = await mkdtemp(path.join(tmpdir(), "omai-cp-"))
  const config = testConfig({ OMAI_LOCAL_PROJECTS_ROOT: root, OMAI_LOCAL_SERVE_COMMAND: fakeVmCommand, ...env })
  const db = await Database.memory()
  const time = clock()
  const provider = LocalVmProvider.make(config)
  const projects = Projects.make(db, config, wrap(provider), time.now)
  const a = await Users.create(db, { username: "a", email: "a@x.y", password: "p" })
  const b = await Users.create(db, { username: "b", email: "b@x.y", password: "p" })
  /** Creates a project for user a and waits until its VM runs. */
  const running = async (name = "Shop") => {
    const created = await projects.create(a.id, name)
    if (typeof created === "string") throw new Error(`create failed: ${created}`)
    await until(
      () => projects.get(a.id, created.id),
      (p) => p?.vmState === "running",
    )
    return created.id
  }
  return { db, config, time, provider, projects, lifecycle: projects.lifecycle, a: a.id, b: b.id, root, running }
}
