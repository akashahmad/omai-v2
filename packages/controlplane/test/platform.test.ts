import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { SignedToken } from "@opencode/util/signed-token"
import { Database } from "../src/db/database.js"
import { Platform } from "../src/platform.js"
import { fakeVmCommand, testConfig, until } from "./fixture/setup.js"

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((fn) => fn()))
})

async function setup(dataDir?: string) {
  const dir = dataDir ?? (await mkdtemp(path.join(tmpdir(), "omai-platform-")))
  const config = testConfig({ OMAI_CONTROLPLANE_DATA_DIR: dir, OMAI_LOCAL_SERVE_COMMAND: fakeVmCommand })
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
