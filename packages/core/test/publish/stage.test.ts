import { afterEach, describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, lstat, readdir, readFile, rm, stat, symlink, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { PublishStage } from "../../src/publish/stage"

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function temp() {
  const dir = await mkdtemp(path.join(tmpdir(), "omai-stage-"))
  dirs.push(dir)
  const source = path.join(dir, "source")
  const stage = path.join(dir, "stage")
  await mkdir(source)
  await mkdir(stage)
  return { source, stage }
}

async function write(root: string, file: string, content: string) {
  await mkdir(path.dirname(path.join(root, file)), { recursive: true })
  await writeFile(path.join(root, file), content)
}

async function exists(file: string) {
  return stat(file).then(
    () => true,
    () => false,
  )
}

async function snapshot(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true })
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const full = path.join(root, entry.name)
      if (entry.isDirectory()) return snapshot(full)
      return [`${full}:${(await stat(full)).mtimeMs}:${(await stat(full)).size}`]
    }),
  )
  return nested.flat().sort()
}

describe("publish stage", () => {
  test("sync copies new and changed files and removes deleted ones", async () => {
    const { source, stage } = await temp()
    await write(source, "a.txt", "one")
    await write(source, "src/b.txt", "two")
    await write(source, ".env", "SECRET=1")
    await write(source, "node_modules/dep/index.js", "x")
    await write(source, "pkg/.git/config", "x")

    const first = await PublishStage.sync(source, stage)
    expect(first).toEqual({ copied: 3, removed: 0 })
    expect(await readFile(path.join(stage, "src/b.txt"), "utf8")).toBe("two")
    expect(await readFile(path.join(stage, ".env"), "utf8")).toBe("SECRET=1")
    expect(await exists(path.join(stage, "node_modules"))).toBe(false)
    expect(await exists(path.join(stage, "pkg/.git"))).toBe(false)

    expect(await PublishStage.sync(source, stage)).toEqual({ copied: 0, removed: 0 })

    await write(source, "a.txt", "changed!")
    await rm(path.join(source, "src/b.txt"))
    await write(source, "c.txt", "new")
    const second = await PublishStage.sync(source, stage)
    expect(second).toEqual({ copied: 2, removed: 1 })
    expect(await readFile(path.join(stage, "a.txt"), "utf8")).toBe("changed!")
    expect(await exists(path.join(stage, "src/b.txt"))).toBe(false)
  })

  test("sync skips symlinks", async () => {
    const { source, stage } = await temp()
    await write(source, "real.txt", "x")
    await symlink(path.join(source, "real.txt"), path.join(source, "link.txt"))
    await symlink(source, path.join(source, "loop"))
    expect(await PublishStage.sync(source, stage)).toEqual({ copied: 1, removed: 0 })
    expect(await exists(path.join(stage, "link.txt"))).toBe(false)
    expect(await exists(path.join(stage, "loop"))).toBe(false)
  })

  test("sync never writes through a stage symlink into the source", async () => {
    const { source, stage } = await temp()
    await write(source, "b.txt", "source bytes")
    await write(source, "d/x.txt", "x")
    await utimes(path.join(source, "b.txt"), new Date(2020, 1, 1), new Date(2020, 1, 1))
    await symlink(path.join(source, "b.txt"), path.join(stage, "b.txt"))
    await symlink(path.join(source, "d"), path.join(stage, "d"))
    const before = await snapshot(source)
    await PublishStage.sync(source, stage)
    expect(await snapshot(source)).toEqual(before)
    expect((await lstat(path.join(stage, "b.txt"))).isFile()).toBe(true)
    expect((await lstat(path.join(stage, "d"))).isDirectory()).toBe(true)
    expect(await readFile(path.join(stage, "d/x.txt"), "utf8")).toBe("x")
  })

  test("sync replaces read-only files", async () => {
    const { source, stage } = await temp()
    await write(source, "ro.txt", "one")
    await chmod(path.join(source, "ro.txt"), 0o444)
    await PublishStage.sync(source, stage)
    await chmod(path.join(source, "ro.txt"), 0o644)
    await write(source, "ro.txt", "two!")
    await chmod(path.join(source, "ro.txt"), 0o444)
    await PublishStage.sync(source, stage)
    expect(await readFile(path.join(stage, "ro.txt"), "utf8")).toBe("two!")
  })

  test("sync keeps the stage node_modules", async () => {
    const { source, stage } = await temp()
    await write(source, "a.txt", "x")
    await write(stage, "node_modules/dep/index.js", "installed")
    await write(stage, "packages/web/node_modules/dep/index.js", "installed")
    await write(source, "packages/web/app.txt", "x")
    await write(stage, "stale.txt", "old")
    await PublishStage.sync(source, stage)
    expect(await readFile(path.join(stage, "node_modules/dep/index.js"), "utf8")).toBe("installed")
    expect(await exists(path.join(stage, "packages/web/node_modules/dep/index.js"))).toBe(true)
    expect(await exists(path.join(stage, "stale.txt"))).toBe(false)
  })

  test("sync never writes into the source", async () => {
    const { source, stage } = await temp()
    await write(source, "a.txt", "one")
    await write(source, "src/deep/b.txt", "two")
    await write(source, ".env.local", "S=1")
    await utimes(path.join(source, "a.txt"), new Date(2020, 1, 1), new Date(2020, 1, 1))
    const before = await snapshot(source)
    const dirBefore = (await stat(source)).mtimeMs
    await PublishStage.sync(source, stage)
    await write(stage, "extra.txt", "x")
    await PublishStage.sync(source, stage)
    await PublishStage.staticAssets(stage)
    expect(await snapshot(source)).toEqual(before)
    expect((await stat(source)).mtimeMs).toBe(dirBefore)
  })

  test("sync preserves the static upload directory and never copies one from the source", async () => {
    const { source, stage } = await temp()
    await write(source, "a.txt", "x")
    await write(source, ".omai-static/evil.txt", "x")
    await PublishStage.sync(source, stage)
    expect(await exists(path.join(stage, ".omai-static"))).toBe(false)
    const dir = await PublishStage.staticAssets(stage)
    await PublishStage.sync(source, stage)
    expect(await exists(path.join(dir, "a.txt"))).toBe(true)
  })

  test("clean deletes build outputs and stays inside the stage", async () => {
    const { source, stage } = await temp()
    await write(stage, "dist/index.html", "x")
    await write(stage, ".astro/types.d.ts", "x")
    await write(stage, "keep.txt", "x")
    await write(source, "outside.txt", "x")
    await PublishStage.clean(stage, ["dist", ".astro", "missing", "../source"])
    expect(await exists(path.join(stage, "dist"))).toBe(false)
    expect(await exists(path.join(stage, ".astro"))).toBe(false)
    expect(await exists(path.join(stage, "keep.txt"))).toBe(true)
    expect(await exists(path.join(source, "outside.txt"))).toBe(true)
  })

  test("clean never deletes through a symlinked directory", async () => {
    const { source, stage } = await temp()
    await write(source, "x.txt", "x")
    await symlink(source, path.join(stage, "dist"))
    await PublishStage.clean(stage, ["dist/x.txt"])
    expect(await exists(path.join(source, "x.txt"))).toBe(true)
    await PublishStage.clean(stage, ["dist"])
    expect(await exists(path.join(source, "x.txt"))).toBe(true)
    expect(await exists(path.join(stage, "dist"))).toBe(false)
  })

  test("staticAssets rejects a root outside the stage", async () => {
    const { stage } = await temp()
    expect(PublishStage.staticAssets(stage, "..")).rejects.toThrow("escapes")
  })

  test("static upload directory has no .env files", async () => {
    const { source, stage } = await temp()
    await write(source, "index.html", "<html>")
    await write(source, "assets/app.js", "x")
    await write(source, ".env", "S=1")
    await write(source, ".env.production", "S=1")
    await write(source, "sub/.env.local", "S=1")
    await write(source, ".DS_Store", "x")
    await write(source, "sub/.git/HEAD", "x")
    await PublishStage.sync(source, stage)
    expect(await exists(path.join(stage, ".env"))).toBe(true)

    const dir = await PublishStage.staticAssets(stage)
    expect(dir).toBe(path.join(stage, ".omai-static"))
    expect((await readdir(dir, { recursive: true })).sort()).toEqual(["assets", "assets/app.js", "index.html", "sub"])
  })

  test("uploadable rejects secrets and tooling files", () => {
    const ok = PublishStage.uploadable()
    expect(ok("index.html")).toBe(true)
    expect(ok("envelope.txt")).toBe(true)
    expect(ok(".env")).toBe(false)
    expect(ok("a/.env.local")).toBe(false)
    expect(ok(".git/config")).toBe(false)
    expect(ok("a/.DS_Store")).toBe(false)
    expect(ok("a/node_modules/x.js")).toBe(false)
  })
})
