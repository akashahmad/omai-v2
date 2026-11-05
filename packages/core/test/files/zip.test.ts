import { describe, expect, test } from "bun:test"
import { mkdir, symlink, writeFile } from "node:fs/promises"
import { randomBytes } from "node:crypto"
import path from "node:path"
import { Zip } from "../../src/files/zip"
import { tmpdir } from "../fixture/tmpdir"

const unzip = (...args: string[]) => {
  const result = Bun.spawnSync(["unzip", ...args])
  return { code: result.exitCode, out: result.stdout.toString() + result.stderr.toString() }
}

async function project(root: string) {
  await mkdir(path.join(root, "src/deep"), { recursive: true })
  await mkdir(path.join(root, "node_modules/pkg"), { recursive: true })
  await mkdir(path.join(root, ".git"), { recursive: true })
  await mkdir(path.join(root, ".next/cache"), { recursive: true })
  await writeFile(path.join(root, "index.html"), "<h1>héllo</h1>\n".repeat(200))
  await writeFile(path.join(root, "src/deep/app.ts"), "export const answer = 42\n")
  await writeFile(path.join(root, "src/empty.txt"), "")
  await writeFile(path.join(root, "logo.png"), randomBytes(2048))
  await writeFile(path.join(root, "big.bin"), randomBytes(5 * 1024 * 1024))
  await writeFile(path.join(root, "big.log"), "line\n".repeat(1024 * 1024))
  await writeFile(path.join(root, ".env"), "SECRET=1")
  await writeFile(path.join(root, ".env.example"), "SECRET=")
  await writeFile(path.join(root, "node_modules/pkg/index.js"), "")
  await writeFile(path.join(root, ".git/HEAD"), "")
  await writeFile(path.join(root, ".next/cache/x"), "")
  await symlink("src/deep/app.ts", path.join(root, "link.ts"))
  await symlink("/etc/hosts", path.join(root, "outside"))
}

describe("Zip", () => {
  test("excluded leaves out dependencies, caches, VCS and secrets but keeps samples", () => {
    expect(Zip.excluded("node_modules/a.js")).toBe(true)
    expect(Zip.excluded("apps/web/.next/x")).toBe(true)
    expect(Zip.excluded(".git/HEAD")).toBe(true)
    expect(Zip.excluded(".env")).toBe(true)
    expect(Zip.excluded("api/.env.production")).toBe(true)
    expect(Zip.excluded(".env.example")).toBe(false)
    expect(Zip.excluded("dist/index.html")).toBe(false)
    expect(Zip.excluded("src/app.ts")).toBe(false)
  })

  test("writes a zip that unzip verifies, with every kept file intact", async () => {
    await using dir = await tmpdir("omai-zip-")
    const root = path.join(dir.path, "my-app")
    await project(root)
    const scanned = await Zip.scan(root, "my-app")
    const names = scanned.entries.map((entry) => entry.name)
    expect(names).toContain("my-app/src/deep/app.ts")
    expect(names).toContain("my-app/.env.example")
    expect(names).toContain("my-app/link.ts")
    expect(names).not.toContain("my-app/.env")
    expect(names).not.toContain("my-app/outside")
    expect(names.some((name) => name.includes("node_modules") || name.includes(".git/") || name.includes(".next"))).toBe(false)

    const output = path.join(dir.path, "out.zip")
    const seen: number[] = []
    const size = await Zip.write(scanned.entries, output, (progress) => seen.push(progress.bytes))
    expect(size).toBe(Bun.file(output).size)
    expect(seen.at(-1)).toBe(scanned.bytes)
    expect(seen.length).toBeGreaterThan(scanned.entries.filter((entry) => entry.type === "file").length)

    const tested = unzip("-t", output)
    expect(tested.out).toContain("No errors detected")
    const extracted = path.join(dir.path, "extracted")
    expect(unzip("-q", output, "-d", extracted).code).toBe(0)
    for (const file of ["index.html", "src/deep/app.ts", "src/empty.txt", "logo.png", "big.bin", "big.log", ".env.example"]) {
      expect(Buffer.compare(
        Buffer.from(await Bun.file(path.join(extracted, "my-app", file)).arrayBuffer()),
        Buffer.from(await Bun.file(path.join(root, file)).arrayBuffer()),
      )).toBe(0)
    }
    // Text deflates; random bytes and PNGs are stored.
    expect(size).toBeLessThan(scanned.bytes)
  })

  test("a cancelled write stops", async () => {
    await using dir = await tmpdir("omai-zip-")
    const root = path.join(dir.path, "app")
    await project(root)
    const scanned = await Zip.scan(root, "app")
    const abort = new AbortController()
    abort.abort()
    await expect(Zip.write(scanned.entries, path.join(dir.path, "out.zip"), () => {}, abort.signal)).rejects.toThrow()
  })
})
