import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { createServer } from "node:net"
import path from "node:path"
import { SignedToken } from "@opencode/util/signed-token"
import { Database } from "../src/db/database.js"
import { Platform } from "../src/platform.js"
import { fakeVmCommand, testConfig, until } from "./fixture/setup.js"

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((fn) => fn()))
})

async function setup(dataDir?: string, env: Record<string, string> = {}) {
  const dir = dataDir ?? (await mkdtemp(path.join(tmpdir(), "omai-platform-")))
  const config = testConfig({ OMAI_CONTROLPLANE_DATA_DIR: dir, OMAI_LOCAL_SERVE_COMMAND: fakeVmCommand, ...env })
  const db = await Database.memory()
  const platform = await Platform.make({ db, config })
  cleanup.push(() => platform.close())
  return { dir, config, db, platform }
}

describe("Platform", () => {
  test("the platform server starts and answers; open hands out a token for it", async () => {
    const s = await setup()
    const opened = await s.platform.open("u1", "sid")
    expect(opened.routerUrl).toBe("http://router.test/vm/platform")
    const claims = SignedToken.verify(opened.token, s.config.publicKey)
    expect(claims?.typ === "vm" && claims.pid).toBe("platform")
    const host = (claims as SignedToken.VmClaims).host
    await until(
      () =>
        fetch(`${host}/api/info`).then(
          (r) => r.ok,
          () => false,
        ),
      Boolean,
    )
    // It holds the secret and nothing that makes it a project.
    const env = (await fetch(`${host}/env`).then((r) => r.json())) as string[]
    expect(env).toContain("OMAI_PLATFORM_SECRET")
    expect(env).not.toContain("OMAI_PROJECT_TOKEN")
    expect(env).not.toContain("OMAI_CONTROL_PLANE_URL")
  })

  test("OMAI_PLATFORM_URL puts the server at that address, so a router elsewhere reaches it", async () => {
    const port = await freePort()
    const s = await setup(undefined, { OMAI_PLATFORM_URL: `http://localhost:${port}/` })
    const opened = await s.platform.open("u1", "sid")
    const claims = SignedToken.verify(opened.token, s.config.publicKey) as SignedToken.VmClaims
    expect(claims.host).toBe(`http://localhost:${port}`)
    await until(
      () =>
        fetch(`http://localhost:${port}/api/info`).then(
          (r) => r.ok,
          () => false,
        ),
      Boolean,
    )
  })

  test("the secret is kept across restarts, readable only by its owner", async () => {
    const first = await setup()
    const secret = first.platform.secret
    await first.platform.close()
    const second = await setup(first.dir)
    expect(second.platform.secret).toBe(secret)
    const file = path.join(first.dir, "platform-secret")
    expect((await readFile(file, "utf8")).trim()).toBe(secret)
    expect((await stat(file)).mode & 0o777).toBe(0o600)
  })

  test("enabled models round-trip and replace", async () => {
    const s = await setup()
    expect(await s.platform.models()).toEqual([])
    await s.platform.setModels([
      { providerID: "openai", modelID: "gpt-5" },
      { providerID: "anthropic", modelID: "claude-x" },
    ])
    await s.platform.setModels([{ providerID: "openai", modelID: "gpt-5" }])
    expect(await s.platform.models()).toEqual([{ providerID: "openai", modelID: "gpt-5" }])
  })
})

function freePort() {
  return new Promise<number>((resolve) => {
    const server = createServer().listen(0, "127.0.0.1", () => {
      const address = server.address()
      server.close(() => resolve(typeof address === "object" && address ? address.port : 0))
    })
  })
}
