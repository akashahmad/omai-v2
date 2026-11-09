import { describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { ProjectVm } from "../../src/project-vm/project-vm"
import { tmpdir } from "../fixture/tmpdir"

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim()

describe("ProjectVm.init", () => {
  test("inits git with one commit when no .git", async () => {
    await using tmp = await tmpdir()
    const result = await ProjectVm.init({ home: tmp.path, slug: "shop" })
    expect(result).toEqual({ directory: path.join(tmp.path, "shop"), created: true })
    expect(git(result.directory, "rev-list", "--count", "HEAD")).toBe("1")
    expect(git(result.directory, "log", "-1", "--format=%an|%cn|%ae")).toBe("O M A I +|O M A I +|noreply@omai.ch")
    expect(git(result.directory, "branch", "--show-current")).toBe("main")
  })

  test("commits files that are already there", async () => {
    await using tmp = await tmpdir()
    await mkdir(path.join(tmp.path, "shop"))
    await writeFile(path.join(tmp.path, "shop", "index.html"), "<h1>hi</h1>")
    const result = await ProjectVm.init({ home: tmp.path, slug: "shop" })
    expect(git(result.directory, "ls-files")).toBe("index.html")
  })

  test("keeps an existing repo", async () => {
    await using tmp = await tmpdir()
    const directory = path.join(tmp.path, "shop")
    await mkdir(directory)
    git(directory, "init", "-b", "trunk")
    git(directory, "remote", "add", "origin", "https://example.com/shop.git")
    for (const n of [1, 2]) {
      await writeFile(path.join(directory, `${n}.txt`), String(n))
      git(directory, "add", "-A")
      git(directory, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-m", `c${n}`)
    }
    const result = await ProjectVm.init({ home: tmp.path, slug: "shop" })
    expect(result.created).toBe(true)
    expect(git(directory, "rev-list", "--count", "HEAD")).toBe("2")
    expect(git(directory, "remote", "get-url", "origin")).toBe("https://example.com/shop.git")
  })

  test("second call is a no-op", async () => {
    await using tmp = await tmpdir()
    await ProjectVm.init({ home: tmp.path, slug: "shop" })
    const again = await ProjectVm.init({ home: tmp.path, slug: "shop" })
    expect(again.created).toBe(false)
    expect(git(again.directory, "rev-list", "--count", "HEAD")).toBe("1")
    expect(await ProjectVm.initialized({ home: tmp.path, slug: "shop" })).toBe(true)
  })
})
