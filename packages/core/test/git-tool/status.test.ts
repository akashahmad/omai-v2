import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { runGit } from "../../src/git-tool/run"
import { GitError, discard, fileDiff, maskText, maskUrl, readStatus, stage } from "../../src/git-tool/status"
import { tmpdir } from "../fixture/tmpdir"

const saved = { ...process.env }
let home: Awaited<ReturnType<typeof tmpdir>>

beforeAll(async () => {
  home = await tmpdir("omai-git-home-")
  process.env.HOME = home.path
  process.env.GIT_CONFIG_GLOBAL = path.join(home.path, "gitconfig")
  process.env.GIT_CONFIG_NOSYSTEM = "1"
})

afterAll(async () => {
  process.env.HOME = saved.HOME
  delete process.env.GIT_CONFIG_GLOBAL
  delete process.env.GIT_CONFIG_NOSYSTEM
  await home[Symbol.asyncDispose]()
})

const git = async (cwd: string, ...args: string[]) => {
  const result = await runGit({ cwd, args })
  if (result.code !== 0) throw new Error(result.stderr)
  return result.stdout
}

const write = async (dir: string, file: string, text: string) => {
  await fs.mkdir(path.dirname(path.join(dir, file)), { recursive: true })
  await Bun.write(path.join(dir, file), text)
}

async function repo(dir: string) {
  await git(dir, "init", "-b", "main")
  await git(dir, "config", "user.name", "Test User")
  await git(dir, "config", "user.email", "test@example.com")
  await write(dir, "a.txt", "one\ntwo\nthree\n")
  await write(dir, "app/b.txt", "b\n")
  await git(dir, "add", "-A")
  await git(dir, "commit", "-m", "init")
}

describe("readStatus", () => {
  test("status throws a GitError when git status fails", async () => {
    await using tmp = await tmpdir()
    await repo(tmp.path)
    await Bun.write(path.join(tmp.path, ".git/index"), "garbage")
    await expect(readStatus(tmp.path)).rejects.toBeInstanceOf(GitError)
  })

  test("status of a non-repo has repo false", async () => {
    await using tmp = await tmpdir()
    const status = await readStatus(tmp.path)
    expect(status.repo).toBe(false)
    expect(status.files).toEqual([])
  })

  test("status lists staged and unstaged changes with counts", async () => {
    await using tmp = await tmpdir()
    await repo(tmp.path)
    await write(tmp.path, "a.txt", "one\nTWO\nthree\nfour\n")
    await write(tmp.path, "new.txt", "x\ny\n")
    await git(tmp.path, "add", "new.txt")
    await write(tmp.path, "loose.txt", "l\n")
    const status = await readStatus(tmp.path)
    expect(status.repo).toBe(true)
    expect(status.branch).toBe("main")
    expect(status.profile).toEqual({ name: "Test User", email: "test@example.com", scope: "local" })
    expect(status.files).toEqual([
      { path: "a.txt", state: "modified", staged: false, unstaged: true, additions: 2, deletions: 1 },
      { path: "new.txt", state: "added", staged: true, unstaged: false, additions: 2, deletions: 0 },
      { path: "loose.txt", state: "untracked", staged: false, unstaged: true, additions: 1, deletions: 0 },
    ])
  })

  test("status parses spaces, unicode and renames", async () => {
    await using tmp = await tmpdir()
    await repo(tmp.path)
    await write(tmp.path, "my file.txt", "s\n")
    await write(tmp.path, "café.md", "c\n")
    await git(tmp.path, "mv", "a.txt", "renamed.txt")
    const status = await readStatus(tmp.path)
    expect(status.files.map((file) => file.path).sort()).toEqual(["café.md", "my file.txt", "renamed.txt"])
    const renamed = status.files.find((file) => file.path === "renamed.txt")
    expect(renamed?.state).toBe("renamed")
    expect(renamed?.oldPath).toBe("a.txt")
    expect(renamed?.staged).toBe(true)
  })

  test("status masks credentials in remote urls", async () => {
    await using tmp = await tmpdir()
    await repo(tmp.path)
    await git(tmp.path, "remote", "add", "origin", "https://u:secret@host/r.git")
    const status = await readStatus(tmp.path)
    expect(status.remotes).toEqual([{ name: "origin", url: "https://***@host/r.git", push: true }])
    expect(JSON.stringify(status)).not.toContain("secret")
  })

  test("status reports ahead and behind against a bare remote", async () => {
    await using tmp = await tmpdir()
    const bare = path.join(tmp.path, "bare.git")
    const one = path.join(tmp.path, "one")
    const two = path.join(tmp.path, "two")
    await git(tmp.path, "init", "--bare", "-b", "main", bare)
    await fs.mkdir(one)
    await repo(one)
    await git(one, "remote", "add", "origin", bare)
    await git(one, "push", "-u", "origin", "main")
    await git(tmp.path, "clone", bare, two)
    await git(two, "config", "user.name", "Other")
    await git(two, "config", "user.email", "o@example.com")
    await write(two, "remote.txt", "r\n")
    await git(two, "add", "-A")
    await git(two, "commit", "-m", "remote")
    await git(two, "push")
    await write(one, "local.txt", "l\n")
    await git(one, "add", "-A")
    await git(one, "commit", "-m", "local")
    await git(one, "fetch")
    const status = await readStatus(one)
    expect(status.upstream).toBe("origin/main")
    expect(status.ahead).toBe(1)
    expect(status.behind).toBe(1)
    expect(status.branches).toEqual([{ name: "main", current: true, upstream: "origin/main" }])
  })

  test("works from a subdirectory of the repo", async () => {
    await using tmp = await tmpdir()
    await repo(tmp.path)
    await write(tmp.path, "app/b.txt", "b\nmore\n")
    const status = await readStatus(path.join(tmp.path, "app"))
    expect(status.root).toBe(tmp.path)
    expect(status.files.map((file) => file.path)).toEqual(["app/b.txt"])
  })

  test("reports a merge in progress", async () => {
    await using tmp = await tmpdir()
    await repo(tmp.path)
    await git(tmp.path, "checkout", "-b", "side")
    await write(tmp.path, "a.txt", "side\n")
    await git(tmp.path, "commit", "-am", "side")
    await git(tmp.path, "checkout", "main")
    await write(tmp.path, "a.txt", "main\n")
    await git(tmp.path, "commit", "-am", "main")
    await runGit({ cwd: tmp.path, args: ["merge", "side"] })
    const status = await readStatus(tmp.path)
    expect(status.operation).toBe("merge")
    expect(status.files[0]?.state).toBe("conflicted")
  })
})

describe("stage and discard", () => {
  test("stage and unstage a path", async () => {
    await using tmp = await tmpdir()
    await repo(tmp.path)
    await write(tmp.path, "a.txt", "changed\n")
    await stage(tmp.path, ["a.txt"], true)
    expect((await readStatus(tmp.path)).files[0]).toMatchObject({ staged: true, unstaged: false })
    await stage(tmp.path, ["a.txt"], false)
    expect((await readStatus(tmp.path)).files[0]).toMatchObject({ staged: false, unstaged: true })
  })

  test("unstage works before the first commit", async () => {
    await using tmp = await tmpdir()
    await git(tmp.path, "init", "-b", "main")
    await write(tmp.path, "a.txt", "x\n")
    await stage(tmp.path, ["a.txt"], true)
    await stage(tmp.path, ["a.txt"], false)
    expect((await readStatus(tmp.path)).files[0]?.state).toBe("untracked")
  })

  test("discard restores a modified file and deletes an untracked one", async () => {
    await using tmp = await tmpdir()
    await repo(tmp.path)
    await write(tmp.path, "a.txt", "changed\n")
    await write(tmp.path, "loose.txt", "l\n")
    await discard(tmp.path, ["a.txt", "loose.txt"])
    expect(await Bun.file(path.join(tmp.path, "a.txt")).text()).toBe("one\ntwo\nthree\n")
    expect(await Bun.file(path.join(tmp.path, "loose.txt")).exists()).toBe(false)
    expect((await readStatus(tmp.path)).files).toEqual([])
  })

  test("discard refuses a path outside the repository", async () => {
    await using tmp = await tmpdir()
    await repo(tmp.path)
    await expect(discard(tmp.path, ["../outside"])).rejects.toThrow()
  })
})

describe("renamed files", () => {
  const rename = async (dir: string) => {
    await repo(dir)
    await git(dir, "mv", "a.txt", "c.txt")
    const file = (await readStatus(dir)).files.find((item) => item.path === "c.txt")
    expect(file).toMatchObject({ state: "renamed", oldPath: "a.txt" })
    return file
  }

  test("unstaging both paths of a rename restores the index", async () => {
    await using tmp = await tmpdir()
    const file = await rename(tmp.path)
    await stage(tmp.path, [file!.path, file!.oldPath!], false)
    expect((await git(tmp.path, "diff", "--cached", "--name-only")).trim()).toBe("")
    expect((await git(tmp.path, "status", "--porcelain")).trim()).toBe("D a.txt\n?? c.txt")
  })

  test("staging an edited rename by its new path alone succeeds", async () => {
    await using tmp = await tmpdir()
    await repo(tmp.path)
    await git(tmp.path, "mv", "a.txt", "c.txt")
    await write(tmp.path, "c.txt", "one\ntwo\nthree\nfour\n")
    expect((await readStatus(tmp.path)).files.find((item) => item.path === "c.txt")).toMatchObject({ staged: true, unstaged: true })
    await stage(tmp.path, ["c.txt"], true)
    const file = (await readStatus(tmp.path)).files.find((item) => item.path === "c.txt")
    expect(file).toMatchObject({ state: "renamed", oldPath: "a.txt", staged: true, unstaged: false })
  })

  test("discarding an edited rename restores the old file and removes the new one", async () => {
    await using tmp = await tmpdir()
    const file = await rename(tmp.path)
    await write(tmp.path, "c.txt", "one\ntwo\nthree\nfour\n")
    await discard(tmp.path, [file!.path, file!.oldPath!])
    expect((await git(tmp.path, "status", "--porcelain")).trim()).toBe("")
    expect(await Bun.file(path.join(tmp.path, "a.txt")).text()).toBe("one\ntwo\nthree\n")
    expect(await Bun.file(path.join(tmp.path, "c.txt")).exists()).toBe(false)
  })

  test("fileDiff of a renamed file reads before from the old path", async () => {
    await using tmp = await tmpdir()
    const file = await rename(tmp.path)
    await write(tmp.path, "c.txt", "one\ntwo\nthree\nfour\n")
    await git(tmp.path, "add", "-A")
    const diff = await fileDiff(tmp.path, { path: file!.path, oldPath: file!.oldPath, staged: true })
    expect(diff).toEqual({ before: "one\ntwo\nthree\n", after: "one\ntwo\nthree\nfour\n", binary: false })
  })
})

describe("untracked files", () => {
  test("many untracked files are all listed", async () => {
    await using tmp = await tmpdir()
    await repo(tmp.path)
    await Promise.all(Array.from({ length: 600 }, (_, index) => write(tmp.path, `many/f${index}.txt`, "x\n")))
    const started = Date.now()
    const status = await readStatus(tmp.path)
    expect(status.files.filter((item) => item.state === "untracked")).toHaveLength(600)
    expect(status.files.every((item) => item.additions === 0)).toBe(true)
    expect(Date.now() - started).toBeLessThan(10_000)
  })

  test("a few untracked files are counted, but not past 1 MB", async () => {
    await using tmp = await tmpdir()
    await repo(tmp.path)
    await write(tmp.path, "small.txt", "a\nb\n")
    await write(tmp.path, "big.txt", "line\n".repeat(400_000))
    const files = (await readStatus(tmp.path)).files
    expect(files.find((item) => item.path === "small.txt")?.additions).toBe(2)
    expect(files.find((item) => item.path === "big.txt")?.additions).toBe(0)
  })
})

describe("discard path handling", () => {
  test("a tracked file passed as ./a.txt or app//b.txt is restored, not deleted", async () => {
    await using tmp = await tmpdir()
    await repo(tmp.path)
    await write(tmp.path, "a.txt", "changed\n")
    await write(tmp.path, "app/b.txt", "changed\n")
    await discard(tmp.path, ["./a.txt", "app//b.txt"])
    expect(await Bun.file(path.join(tmp.path, "a.txt")).text()).toBe("one\ntwo\nthree\n")
    expect(await Bun.file(path.join(tmp.path, "app/b.txt")).text()).toBe("b\n")
  })

  test("a directory is rejected and nothing is deleted", async () => {
    await using tmp = await tmpdir()
    await repo(tmp.path)
    await write(tmp.path, "app/b.txt", "changed\n")
    await write(tmp.path, "app/loose.txt", "l\n")
    const error = await discard(tmp.path, ["app"]).catch((caught: Error) => caught)
    expect(error).toBeInstanceOf(GitError)
    expect(error).toMatchObject({ kind: "other", message: "Choose files, not folders, to discard" })
    expect(await Bun.file(path.join(tmp.path, "app/b.txt")).text()).toBe("changed\n")
    expect(await Bun.file(path.join(tmp.path, "app/loose.txt")).exists()).toBe(true)
  })
})

describe("fileDiff", () => {
  test("fileDiff rejects a commit that could be parsed as an option", async () => {
    await using tmp = await tmpdir()
    await repo(tmp.path)
    await expect(fileDiff(tmp.path, { path: "a.txt", commit: "--output=x" })).rejects.toBeInstanceOf(GitError)
  })

  test("fileDiff returns before and after of a modified file", async () => {
    await using tmp = await tmpdir()
    await repo(tmp.path)
    await write(tmp.path, "a.txt", "changed\n")
    expect(await fileDiff(tmp.path, { path: "a.txt" })).toEqual({ before: "one\ntwo\nthree\n", after: "changed\n", binary: false })
    await stage(tmp.path, ["a.txt"], true)
    expect(await fileDiff(tmp.path, { path: "a.txt", staged: true })).toEqual({ before: "one\ntwo\nthree\n", after: "changed\n", binary: false })
    await git(tmp.path, "commit", "-m", "next")
    const hash = (await git(tmp.path, "rev-parse", "HEAD")).trim()
    expect(await fileDiff(tmp.path, { path: "a.txt", commit: hash })).toEqual({ before: "one\ntwo\nthree\n", after: "changed\n", binary: false })
  })

  test("fileDiff of an untracked file has an empty before and flags binary files", async () => {
    await using tmp = await tmpdir()
    await repo(tmp.path)
    await write(tmp.path, "n.txt", "new\n")
    await Bun.write(path.join(tmp.path, "img.bin"), new Uint8Array([1, 0, 2]))
    expect(await fileDiff(tmp.path, { path: "n.txt" })).toEqual({ before: "", after: "new\n", binary: false })
    expect((await fileDiff(tmp.path, { path: "img.bin" })).binary).toBe(true)
  })
})

describe("maskUrl", () => {
  test.each([
    ["https://u:secret@host/r.git", "https://***@host/r.git"],
    ["https://token@host/r.git", "https://***@host/r.git"],
    ["https://host/r.git", "https://host/r.git"],
    ["git@github.com:o/r.git", "git@github.com:o/r.git"],
  ] as const)("%s", (input, expected) => {
    expect(maskUrl(input)).toBe(expected)
  })
})

describe("maskText", () => {
  test("masks the whole userinfo when the password contains an @", () => {
    expect(maskText("fatal: unable to access 'https://u:p@ss@host/x'")).toBe("fatal: unable to access 'https://***@host/x'")
  })
})
