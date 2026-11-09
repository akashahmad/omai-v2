import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import { ProjectVm } from "../../src/project-vm/project-vm"
import { tmpdir } from "../fixture/tmpdir"
import { buildZip, type TestEntry } from "./zip-builder"

async function unzip(root: string, entries: TestEntry[], maxBytes = 1024 * 1024) {
  const zip = path.join(root, "upload.zip")
  const directory = path.join(root, "project")
  await mkdir(directory, { recursive: true })
  await writeFile(zip, buildZip(entries))
  const result = await ProjectVm.unzip({ zip, directory, maxBytes }).then(
    (value) => value,
    (error: unknown) => error,
  )
  return { result, directory }
}

describe("ProjectVm.unzip", () => {
  test("extracts and strips a single top folder", async () => {
    await using tmp = await tmpdir()
    const { result, directory } = await unzip(tmp.path, [
      { name: "shop-main/" },
      { name: "shop-main/package.json", data: '{"name":"shop"}', deflate: true },
      { name: "shop-main/src/index.ts", data: "export {}" },
      { name: "shop-main/run.sh", data: "#!/bin/sh", mode: 0o100755 },
      { name: "__MACOSX/shop-main/._package.json", data: "junk" },
    ])
    expect(result).toEqual({ files: 3 })
    expect(await readFile(path.join(directory, "package.json"), "utf8")).toBe('{"name":"shop"}')
    expect(await readFile(path.join(directory, "src/index.ts"), "utf8")).toBe("export {}")
    expect((await stat(path.join(directory, "run.sh"))).mode & 0o111).not.toBe(0)
    expect(existsSync(path.join(directory, "__MACOSX"))).toBe(false)
  })

  test("keeps paths when there is no single top folder", async () => {
    await using tmp = await tmpdir()
    const { result, directory } = await unzip(tmp.path, [
      { name: "a.txt", data: "a" },
      { name: "src/b.txt", data: "b" },
    ])
    expect(result).toEqual({ files: 2 })
    expect((await readdir(directory)).sort()).toEqual(["a.txt", "src"])
  })

  test("rejects ../evil", async () => {
    await using tmp = await tmpdir()
    const { result, directory } = await unzip(tmp.path, [
      { name: "ok.txt", data: "ok" },
      { name: "../evil", data: "x" },
    ])
    expect(result).toBeInstanceOf(ProjectVm.UnzipError)
    expect(await readdir(directory)).toEqual([])
    expect(existsSync(path.join(tmp.path, "evil"))).toBe(false)
  })

  test("rejects a nested traversal", async () => {
    await using tmp = await tmpdir()
    const { result } = await unzip(tmp.path, [{ name: "a/../../evil", data: "x" }])
    expect(result).toBeInstanceOf(ProjectVm.UnzipError)
    expect(existsSync(path.join(tmp.path, "evil"))).toBe(false)
  })

  test("rejects an absolute path", async () => {
    await using tmp = await tmpdir()
    const { result, directory } = await unzip(tmp.path, [{ name: "/tmp/evil", data: "x" }])
    expect(result).toBeInstanceOf(ProjectVm.UnzipError)
    expect(await readdir(directory)).toEqual([])
  })

  test("rejects a symlink entry", async () => {
    await using tmp = await tmpdir()
    const { result, directory } = await unzip(tmp.path, [
      { name: "ok.txt", data: "ok" },
      { name: "link", data: "/etc/passwd", mode: 0o120777 },
    ])
    expect(result).toBeInstanceOf(ProjectVm.UnzipError)
    expect(await readdir(directory)).toEqual([])
  })

  test("rejects when over maxBytes", async () => {
    await using tmp = await tmpdir()
    const { result, directory } = await unzip(
      tmp.path,
      [
        { name: "a.txt", data: "x".repeat(600) },
        { name: "b.txt", data: "x".repeat(600) },
      ],
      1000,
    )
    expect(result).toBeInstanceOf(ProjectVm.UnzipError)
    expect(await readdir(directory)).toEqual([])
  })

  test("rejects a file that is not a zip", async () => {
    await using tmp = await tmpdir()
    const zip = path.join(tmp.path, "upload.zip")
    await writeFile(zip, "not a zip")
    const result = await ProjectVm.unzip({ zip, directory: tmp.path, maxBytes: 1000 }).catch((error: unknown) => error)
    expect(result).toBeInstanceOf(ProjectVm.UnzipError)
  })
})
