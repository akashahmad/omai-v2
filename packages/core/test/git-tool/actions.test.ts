import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import {
  abort,
  branchCreate,
  branchSwitch,
  commit,
  continueOperation,
  fetch,
  init,
  log,
  pull,
  push,
  remoteAdd,
  remoteRemove,
  remoteSet,
  setProfile,
  show,
} from "../../src/git-tool/actions"
import { runGit } from "../../src/git-tool/run"
import { GitError, readStatus, stage } from "../../src/git-tool/status"
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

const write = (dir: string, file: string, text: string) => Bun.write(path.join(dir, file), text)

const failure = (promise: Promise<unknown>) =>
  promise.then(
    () => {
      throw new Error("expected a GitError")
    },
    (error) => {
      expect(error).toBeInstanceOf(GitError)
      return error as GitError
    },
  )

async function identify(dir: string) {
  await git(dir, "config", "user.name", "Test User")
  await git(dir, "config", "user.email", "test@example.com")
}

async function repo(dir: string, profile = true) {
  await git(dir, "init", "-b", "main")
  if (profile) await identify(dir)
  await write(dir, "a.txt", "one\ntwo\nthree\n")
  await git(dir, "add", "-A")
  if (profile) await git(dir, "commit", "-m", "init")
}

/** A working repo with one commit and a bare `origin`; nothing is pushed yet. */
async function withRemote(dir: string) {
  const bare = path.join(dir, "remote.git")
  const work = path.join(dir, "work")
  await fs.mkdir(work)
  await git(dir, "init", "--bare", "-b", "main", bare)
  await repo(work)
  await git(work, "remote", "add", "origin", bare)
  return { bare, work }
}

/** Two clones of the same pushed history. */
async function clones(dir: string) {
  const { bare, work } = await withRemote(dir)
  await git(work, "push", "-u", "origin", "main")
  const other = path.join(dir, "other")
  await git(dir, "clone", bare, other)
  await identify(other)
  return { bare, work, other }
}

async function diverge(dir: string, file: { work: string; other: string }) {
  await write(file.other, "theirs.txt", "theirs\n")
  await git(file.other, "add", "-A")
  await git(file.other, "commit", "-m", "theirs")
  await git(file.other, "push")
  await write(file.work, "mine.txt", "mine\n")
  await git(file.work, "add", "-A")
  await git(file.work, "commit", "-m", "mine")
  await git(file.work, "fetch")
}

describe("commit", () => {
  test("commit with nothing staged is refused", async () => {
    await using tmp = await tmpdir()
    await repo(tmp.path)
    await write(tmp.path, "loose.txt", "x\n")
    expect((await failure(commit(tmp.path, { message: "nope" }))).kind).toBe("nothing-to-commit")
  })

  test("commit without a profile is refused with kind no-profile until setProfile", async () => {
    await using tmp = await tmpdir()
    await repo(tmp.path, false)
    expect((await failure(commit(tmp.path, { message: "first" }))).kind).toBe("no-profile")
    await setProfile(tmp.path, { name: "Local Person", email: "local@example.com", global: false })
    expect((await commit(tmp.path, { message: "first" })).message).toBe("Committed “first”")
    expect((await readStatus(tmp.path)).profile).toEqual({ name: "Local Person", email: "local@example.com", scope: "local" })
  })

  test("setProfile global writes the global config", async () => {
    await using tmp = await tmpdir()
    await repo(tmp.path, false)
    await setProfile(tmp.path, { name: "Global Person", email: "global@example.com", global: true })
    const status = await readStatus(tmp.path)
    expect(status.profile).toEqual({ name: "Global Person", email: "global@example.com", scope: "global" })
    await fs.rm(process.env.GIT_CONFIG_GLOBAL!, { force: true })
  })

  test("commit commits only staged files", async () => {
    await using tmp = await tmpdir()
    await repo(tmp.path)
    await write(tmp.path, "a.txt", "changed\n")
    await write(tmp.path, "b.txt", "new\n")
    await stage(tmp.path, ["b.txt"], true)
    await commit(tmp.path, { message: "add b\n\nwith a body" })
    const status = await readStatus(tmp.path)
    expect(status.files.map((file) => file.path)).toEqual(["a.txt"])
    expect(await git(tmp.path, "show", "--name-only", "--format=%s", "HEAD")).toBe("add b\n\nb.txt\n")
  })

  test("amend rewrites the last commit", async () => {
    await using tmp = await tmpdir()
    await repo(tmp.path)
    await commit(tmp.path, { message: "better", amend: true })
    expect((await git(tmp.path, "log", "--format=%s")).trim()).toBe("better")
  })

  test("amend is refused when the last commit is pushed", async () => {
    await using tmp = await tmpdir()
    const dirs = await withRemote(tmp.path)
    await push(dirs.work, {})
    const error = await failure(commit(dirs.work, { message: "again", amend: true }))
    expect(error.kind).toBe("other")
    expect(error.message).toBe("The last commit has already been pushed")
  })
})

describe("push, pull, fetch", () => {
  test("first push sets the upstream", async () => {
    await using tmp = await tmpdir()
    const dirs = await withRemote(tmp.path)
    expect((await push(dirs.work, {})).message).toBe("Pushed 1 commit to origin/main")
    expect((await readStatus(dirs.work)).upstream).toBe("origin/main")
    expect((await push(dirs.work, {})).message).toBe("Already up to date")
  })

  test("push goes to a differently named upstream branch", async () => {
    await using tmp = await tmpdir()
    const dirs = await withRemote(tmp.path)
    await git(dirs.work, "push", "origin", "main:master")
    await git(dirs.work, "branch", "--set-upstream-to=origin/master")
    await write(dirs.work, "more.txt", "x\n")
    await git(dirs.work, "add", "-A")
    await git(dirs.work, "commit", "-m", "more")
    expect((await push(dirs.work, {})).message).toBe("Pushed 1 commit to origin/master")
    expect((await git(dirs.bare, "rev-parse", "master")).trim()).toBe((await git(dirs.work, "rev-parse", "HEAD")).trim())
    expect((await runGit({ cwd: dirs.bare, args: ["rev-parse", "--verify", "-q", "main"] })).code).not.toBe(0)
  })

  test("push without a remote fails as no-remote", async () => {
    await using tmp = await tmpdir()
    await repo(tmp.path)
    expect((await failure(push(tmp.path, {}))).kind).toBe("no-remote")
  })

  test("push without credentials fails fast as auth", async () => {
    await using tmp = await tmpdir()
    await repo(tmp.path)
    await git(tmp.path, "remote", "add", "origin", "https://127.0.0.1:9/x.git")
    const started = Date.now()
    const error = await failure(push(tmp.path, {}))
    expect(Date.now() - started).toBeLessThan(15_000)
    expect(["auth", "other"]).toContain(error.kind)
    expect(error.message).toContain("127.0.0.1")
  })

  test("pull fast-forwards", async () => {
    await using tmp = await tmpdir()
    const dirs = await clones(tmp.path)
    expect((await pull(dirs.work, {})).message).toBe("Already up to date")
    await write(dirs.other, "n.txt", "n\n")
    await git(dirs.other, "add", "-A")
    await git(dirs.other, "commit", "-m", "n")
    await git(dirs.other, "push")
    expect((await pull(dirs.work, {})).message).toBe("Pulled 1 commit")
    expect(await Bun.file(path.join(dirs.work, "n.txt")).text()).toBe("n\n")
  })

  test("pull of diverged branches fails as diverged, then rebase and merge both succeed", async () => {
    await using tmp = await tmpdir()
    const dirs = await clones(tmp.path)
    await diverge(tmp.path, dirs)
    const error = await failure(pull(dirs.work, {}))
    expect(error.kind).toBe("diverged")
    expect(error.message).toBe("Your branch and origin/main have both changed")
    expect((await pull(dirs.work, { mode: "rebase" })).message).toBe("Pulled 1 commit")
    expect((await git(dirs.work, "log", "--format=%s")).trim().split("\n")).toEqual(["mine", "theirs", "init"])

    await using again = await tmpdir()
    const second = await clones(again.path)
    await diverge(again.path, second)
    expect((await pull(second.work, { mode: "merge" })).message).toBe("Pulled 1 commit")
    expect((await git(second.work, "rev-list", "--merges", "--count", "HEAD")).trim()).toBe("1")
  })

  test("pull with a conflict reports conflict and abort restores", async () => {
    await using tmp = await tmpdir()
    const dirs = await clones(tmp.path)
    await write(dirs.other, "a.txt", "theirs\n")
    await git(dirs.other, "commit", "-am", "theirs")
    await git(dirs.other, "push")
    await write(dirs.work, "a.txt", "mine\n")
    await git(dirs.work, "commit", "-am", "mine")
    const error = await failure(pull(dirs.work, { mode: "merge" }))
    expect(error.kind).toBe("conflict")
    expect(error.message).toBe("Pulling stopped on conflicts in 1 file")
    expect((await readStatus(dirs.work)).operation).toBe("merge")
    await abort(dirs.work)
    const status = await readStatus(dirs.work)
    expect(status.operation).toBeUndefined()
    expect(status.files).toEqual([])
    expect(await Bun.file(path.join(dirs.work, "a.txt")).text()).toBe("mine\n")
  })

  test("a merge resolved to match HEAD can still be committed", async () => {
    await using tmp = await tmpdir()
    const dirs = await clones(tmp.path)
    await write(dirs.other, "a.txt", "theirs\n")
    await git(dirs.other, "commit", "-am", "theirs")
    await git(dirs.other, "push")
    await write(dirs.work, "a.txt", "mine\n")
    await git(dirs.work, "commit", "-am", "mine")
    await failure(pull(dirs.work, { mode: "merge" }))
    await git(dirs.work, "checkout", "--ours", "a.txt")
    await stage(dirs.work, ["a.txt"], true)
    await commit(dirs.work, { message: "keep mine" })
    expect((await readStatus(dirs.work)).operation).toBeUndefined()
    expect((await runGit({ cwd: dirs.work, args: ["rev-parse", "-q", "--verify", "MERGE_HEAD"] })).code).not.toBe(0)
  })

  test("continue finishes a rebase once its conflicts are resolved and staged", async () => {
    await using tmp = await tmpdir()
    const dirs = await clones(tmp.path)
    await write(dirs.other, "a.txt", "theirs\n")
    await write(dirs.other, "theirs.txt", "theirs\n")
    await git(dirs.other, "add", "-A")
    await git(dirs.other, "commit", "-m", "theirs")
    await git(dirs.other, "push")
    await write(dirs.work, "a.txt", "mine\n")
    await write(dirs.work, "mine.txt", "mine\n")
    await git(dirs.work, "add", "-A")
    await git(dirs.work, "commit", "-m", "mine")
    expect((await failure(pull(dirs.work, { mode: "rebase" }))).kind).toBe("conflict")
    expect((await readStatus(dirs.work)).operation).toBe("rebase")
    expect((await failure(continueOperation(dirs.work))).message).toBe("Resolve the conflicts in 1 file first")
    await write(dirs.work, "a.txt", "both\n")
    await stage(dirs.work, ["a.txt"], true)
    expect((await continueOperation(dirs.work)).message).toBe("Finished the rebase")
    const gitDir = (await git(dirs.work, "rev-parse", "--absolute-git-dir")).trim()
    expect(await fs.exists(path.join(gitDir, "rebase-merge"))).toBe(false)
    expect((await readStatus(dirs.work)).operation).toBeUndefined()
    expect((await git(dirs.work, "log", "--format=%s")).trim().split("\n")).toEqual(["mine", "theirs", "init"])
    expect(await Bun.file(path.join(dirs.work, "theirs.txt")).text()).toBe("theirs\n")
    expect(await Bun.file(path.join(dirs.work, "mine.txt")).text()).toBe("mine\n")
    expect(await Bun.file(path.join(dirs.work, "a.txt")).text()).toBe("both\n")
  })

  test("continue concludes a merge without an editor", async () => {
    await using tmp = await tmpdir()
    const dirs = await clones(tmp.path)
    await write(dirs.other, "a.txt", "theirs\n")
    await git(dirs.other, "commit", "-am", "theirs")
    await git(dirs.other, "push")
    await write(dirs.work, "a.txt", "mine\n")
    await git(dirs.work, "commit", "-am", "mine")
    await failure(pull(dirs.work, { mode: "merge" }))
    await write(dirs.work, "a.txt", "both\n")
    await stage(dirs.work, ["a.txt"], true)
    expect((await continueOperation(dirs.work)).message).toBe("Finished the merge")
    expect((await readStatus(dirs.work)).operation).toBeUndefined()
    expect((await git(dirs.work, "rev-list", "--merges", "--count", "HEAD")).trim()).toBe("1")
  })

  test("push failures never expose URL credentials", async () => {
    await using tmp = await tmpdir()
    await repo(tmp.path)
    await git(tmp.path, "remote", "add", "origin", "https://u:secret@127.0.0.1:9/x.git")
    const error = await failure(push(tmp.path, {}))
    expect(error.message).not.toContain("secret")
    expect(error.details).not.toContain("secret")
  })

  test("abort with nothing running is refused", async () => {
    await using tmp = await tmpdir()
    await repo(tmp.path)
    expect((await failure(abort(tmp.path))).kind).toBe("other")
  })

  test("fetch brings in remote commits without merging", async () => {
    await using tmp = await tmpdir()
    const dirs = await clones(tmp.path)
    await write(dirs.other, "n.txt", "n\n")
    await git(dirs.other, "add", "-A")
    await git(dirs.other, "commit", "-m", "n")
    await git(dirs.other, "push")
    await fetch(dirs.work)
    expect((await readStatus(dirs.work)).behind).toBe(1)
  })
})

describe("remotes and branches", () => {
  test("remoteAdd, remoteSet and remoteRemove manage remotes", async () => {
    await using tmp = await tmpdir()
    await repo(tmp.path)
    await remoteAdd(tmp.path, { name: "origin", url: "https://example.com/a.git" })
    await remoteSet(tmp.path, { name: "origin", url: "https://user:secret@example.com/b.git" })
    expect((await readStatus(tmp.path)).remotes).toEqual([{ name: "origin", url: "https://***@example.com/b.git", push: true }])
    await remoteRemove(tmp.path, "origin")
    expect((await readStatus(tmp.path)).remotes).toEqual([])
    expect((await failure(remoteRemove(tmp.path, "origin"))).kind).toBe("no-remote")
  })

  test("remoteAdd rejects a bad name", async () => {
    await using tmp = await tmpdir()
    await repo(tmp.path)
    expect((await failure(remoteAdd(tmp.path, { name: "bad name", url: "https://example.com/a.git" }))).kind).toBe("other")
    expect((await failure(remoteAdd(tmp.path, { name: "--evil", url: "https://example.com/a.git" }))).kind).toBe("other")
    expect((await failure(remoteAdd(tmp.path, { name: "ok", url: "-oProxyCommand=x" }))).kind).toBe("other")
    expect((await readStatus(tmp.path)).remotes).toEqual([])
  })

  test("branchCreate switches to the new branch", async () => {
    await using tmp = await tmpdir()
    await repo(tmp.path)
    await branchCreate(tmp.path, "feature")
    expect((await readStatus(tmp.path)).branch).toBe("feature")
    await branchSwitch(tmp.path, "main")
    expect((await readStatus(tmp.path)).branch).toBe("main")
    expect((await failure(branchCreate(tmp.path, "bad name"))).kind).toBe("other")
    const missing = await failure(branchSwitch(tmp.path, "missing"))
    expect(missing.kind).toBe("other")
    expect(missing.message.startsWith("fatal:")).toBe(false)
  })

  test("init creates a repository on main and leaves an existing one alone", async () => {
    await using tmp = await tmpdir()
    await init(tmp.path)
    const status = await readStatus(tmp.path)
    expect(status.repo).toBe(true)
    expect(status.branch).toBe("main")
    await init(tmp.path)
  })
})

describe("history", () => {
  test("log pages by 20 with more", async () => {
    await using tmp = await tmpdir()
    await repo(tmp.path)
    for (const index of Array.from({ length: 24 }, (_, i) => i))
      await git(tmp.path, "commit", "--allow-empty", "-m", `c${index}\n\nbody ${index}`)
    const first = await log(tmp.path, {})
    expect(first.commits).toHaveLength(20)
    expect(first.more).toBe(true)
    expect(first.commits[0]).toMatchObject({
      subject: "c23",
      body: "body 23",
      author: "Test User",
      email: "test@example.com",
      merge: false,
    })
    expect(first.commits[0].short.length).toBeGreaterThanOrEqual(7)
    const second = await log(tmp.path, { skip: 20 })
    expect(second.commits.map((item) => item.subject)).toEqual(["c3", "c2", "c1", "c0", "init"])
    expect(second.more).toBe(false)
  })

  test("paging by offset returns every commit once across a merge", async () => {
    await using tmp = await tmpdir()
    await repo(tmp.path)
    await git(tmp.path, "switch", "-c", "side")
    await git(tmp.path, "commit", "--allow-empty", "-m", "s1")
    await git(tmp.path, "commit", "--allow-empty", "-m", "s2")
    await git(tmp.path, "switch", "main")
    await git(tmp.path, "commit", "--allow-empty", "-m", "m1")
    await git(tmp.path, "merge", "--no-ff", "-m", "merge", "side")
    await git(tmp.path, "commit", "--allow-empty", "-m", "m2")
    const first = await log(tmp.path, { limit: 3 })
    const second = await log(tmp.path, { skip: 3, limit: 3 })
    const third = await log(tmp.path, { skip: 6, limit: 3 })
    const all = [...first.commits, ...second.commits, ...third.commits].map((item) => item.subject)
    expect(first.more).toBe(true)
    expect(second.more).toBe(false)
    expect(third.commits).toEqual([])
    expect(all).toHaveLength(6)
    expect([...all].sort()).toEqual(["init", "m1", "m2", "merge", "s1", "s2"])
  })

  test("log of a repository without commits is empty", async () => {
    await using tmp = await tmpdir()
    await repo(tmp.path, false)
    expect(await log(tmp.path, {})).toEqual({ commits: [], more: false })
  })

  test("show lists the files a commit changed", async () => {
    await using tmp = await tmpdir()
    await repo(tmp.path)
    await write(tmp.path, "a.txt", "one\nTWO\nthree\nfour\n")
    await write(tmp.path, "b.txt", "b\n")
    await git(tmp.path, "add", "-A")
    await git(tmp.path, "commit", "-m", "second")
    const hash = (await git(tmp.path, "rev-parse", "HEAD")).trim()
    const shown = await show(tmp.path, hash)
    expect(shown.commit.subject).toBe("second")
    expect(shown.files).toEqual([
      { path: "a.txt", state: "modified", staged: false, unstaged: false, additions: 2, deletions: 1 },
      { path: "b.txt", state: "added", staged: false, unstaged: false, additions: 1, deletions: 0 },
    ])
    const root = (await git(tmp.path, "rev-list", "--max-parents=0", "HEAD")).trim()
    expect((await show(tmp.path, root)).files.map((file) => file.path)).toEqual(["a.txt"])
    expect((await failure(show(tmp.path, "--oops"))).kind).toBe("other")
  })
})
