import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { fingerprint, install, installCommand, needsInstall } from "@opencode/core/preview/install"

const fakePm = `node ${JSON.stringify(path.join(import.meta.dir, "fixtures", "fake-pm.mjs"))}`

async function project() {
  const root = await mkdtemp(path.join(tmpdir(), "omai-install-"))
  await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "app" }))
  return root
}

const run = (root: string, env: Record<string, string> = {}, signal = new AbortController().signal) =>
  install({
    root,
    command: `${fakePm} first`,
    retry: `${fakePm} relaxed`,
    env: { ...(process.env as Record<string, string>), ...env },
    onLog: () => {},
    signal,
  })

const runs = async (root: string) => Number(await readFile(path.join(root, ".runs"), "utf8"))

describe("needsInstall", () => {
  test("true without node_modules", async () => {
    const root = await project()

    expect(await needsInstall(root, await fingerprint(root))).toBe(true)
  })

  test("false after an install with the same fingerprint", async () => {
    const root = await project()
    await run(root)

    expect(await needsInstall(root, await fingerprint(root))).toBe(false)
  })

  test("true after package.json changes", async () => {
    const root = await project()
    await run(root)
    await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "app", dependencies: { vite: "6" } }))

    expect(await needsInstall(root, await fingerprint(root))).toBe(true)
  })
})

describe("install", () => {
  test("a failed install leaves no record, so the next one installs again", async () => {
    const root = await project()
    const result = await run(root, { FAKE_PM_EXIT: "1" })

    expect(result.ok).toBe(false)
    expect(await needsInstall(root, await fingerprint(root))).toBe(true)
  })

  test("retries once from clean, with the relaxed command", async () => {
    const root = await project()
    const result = await run(root, { FAKE_PM_FAIL_ONCE: "1" })

    expect(result.ok).toBe(true)
    expect(await runs(root)).toBe(2)
    expect(await readFile(path.join(root, ".args-2"), "utf8")).toBe("relaxed")
  })

  test("aborting kills the install", async () => {
    const root = await project()
    const controller = new AbortController()
    const started = Date.now()
    setTimeout(() => controller.abort(), 100)
    const result = await run(root, { FAKE_PM_SLEEP: "60000" }, controller.signal)

    expect(result.ok).toBe(false)
    expect(Date.now() - started).toBeLessThan(6_000)
  })
})

describe("installCommand", () => {
  test("uses corepack when pnpm is missing", () => {
    expect(installCommand("pnpm", (bin) => bin === "corepack").command).toStartWith("corepack pnpm install")
  })

  test("falls back to npm without corepack, and says so", () => {
    const result = installCommand("yarn", () => false)

    expect(result.command).toStartWith("npm install")
    expect(result.note).toBeDefined()
  })

  test("yarn turns off immutable installs", () => {
    expect(installCommand("yarn", () => true).env.YARN_ENABLE_IMMUTABLE_INSTALLS).toBe("false")
  })

  test("the retry relaxes peer dependencies", () => {
    expect(installCommand("npm", () => true).retry).toContain("--legacy-peer-deps")
    expect(installCommand("pnpm", () => true).retry).toContain("--config.strict-peer-dependencies=false")
  })

  test("does not let engine-strict block a preview", () => {
    expect(installCommand("npm", () => true).command).toContain("--engine-strict=false")
    expect(installCommand("pnpm", () => true).command).toContain("--config.engine-strict=false")
  })
})
