import { describe, expect, test } from "bun:test"
import type { GitTool } from "@opencode/schema/git-tool"
import { age, canCommit, groups, pathsOf, pushRemote, resolvePrompt, summary } from "./model"

const t = (key: string, params: Record<string, string | number> = {}) =>
  `${key}${Object.keys(params).length ? JSON.stringify(params) : ""}`

const file = (path: string, input: Partial<GitTool.FileChange> = {}): GitTool.FileChange => ({
  path,
  state: "modified",
  staged: false,
  unstaged: true,
  additions: 1,
  deletions: 0,
  ...input,
})

const status = (input: Partial<GitTool.Status> = {}): GitTool.Status => ({
  repo: true,
  branch: "main",
  detached: false,
  ahead: 0,
  behind: 0,
  files: [],
  remotes: [],
  branches: [],
  profile: { name: "Ada", email: "ada@example.com", scope: "global" },
  ...input,
})

describe("summary", () => {
  test("names the branch, its upstream and the ahead and behind counts", () => {
    expect(summary(status({ upstream: "origin/main", ahead: 2, behind: 1 }), t)).toBe(
      'git.summary.branch{"branch":"main"} · origin/main · git.summary.ahead{"count":2} · git.summary.behind{"count":1}',
    )
  })

  test("says up to date when the upstream matches", () => {
    expect(summary(status({ upstream: "origin/main" }), t)).toBe(
      'git.summary.branch{"branch":"main"} · origin/main · git.summary.synced',
    )
  })

  test("says the branch is not connected", () => {
    expect(summary(status(), t)).toBe('git.summary.branch{"branch":"main"} · git.summary.noUpstream')
  })

  test("names a detached HEAD", () => {
    expect(summary(status({ detached: true, branch: undefined }), t)).toBe("git.summary.detached")
  })

  test("names an operation in progress", () => {
    expect(summary(status({ operation: "merge" }), t)).toBe(
      'git.summary.branch{"branch":"main"} · git.summary.noUpstream · git.summary.merge',
    )
  })

  test("is empty outside a repository", () => {
    expect(summary(status({ repo: false }), t)).toBe("git.summary.notRepo")
  })
})

describe("groups", () => {
  test("splits files into staged, changes and conflicted", () => {
    const result = groups([
      file("a", { staged: true, unstaged: false }),
      file("b"),
      file("c", { state: "conflicted", staged: false }),
      file("d", { staged: true, unstaged: true }),
    ])

    expect(result.staged.map((item) => item.path)).toEqual(["a", "d"])
    expect(result.changes.map((item) => item.path)).toEqual(["b", "d"])
    expect(result.conflicted.map((item) => item.path)).toEqual(["c"])
  })
})

describe("canCommit", () => {
  const staged = [file("a", { staged: true, unstaged: false })]

  test("allows a message, a staged file and a profile", () => {
    expect(canCommit(status({ files: staged }), "fix it")).toBe(true)
  })

  test("refuses an empty message", () => {
    expect(canCommit(status({ files: staged }), "  \n")).toBe(false)
  })

  test("refuses with nothing staged", () => {
    expect(canCommit(status({ files: [file("a")] }), "fix it")).toBe(false)
  })

  test("refuses without a profile", () => {
    expect(canCommit(status({ files: staged, profile: { scope: "none" } }), "fix it")).toBe(false)
    expect(canCommit(status({ files: staged, profile: { name: "Ada", scope: "local" } }), "fix it")).toBe(false)
  })

  test("refuses while files are conflicted", () => {
    expect(canCommit(status({ files: [...staged, file("c", { state: "conflicted" })] }), "fix it")).toBe(false)
  })
})

describe("pathsOf", () => {
  const renamed = file("c.txt", { state: "renamed", oldPath: "a.txt" })

  test("adds a rename's old path only when asked", () => {
    expect(pathsOf([renamed, file("b.txt")], true)).toEqual(["c.txt", "a.txt", "b.txt"])
    expect(pathsOf([renamed, file("b.txt")], false)).toEqual(["c.txt", "b.txt"])
  })
})

describe("resolvePrompt", () => {
  test("lists the conflicted paths in a text block", () => {
    const prompt = resolvePrompt([file("src/a.ts", { state: "conflicted" }), file("b.md", { state: "conflicted" })])

    expect(prompt).toContain("```text\nsrc/a.ts\nb.md\n```")
  })
})

describe("pushRemote", () => {
  const remote = (name: string): GitTool.Remote => ({ name, url: `https://example.com/${name}.git`, push: false })

  test("uses the upstream's remote, the longest matching name first", () => {
    expect(
      pushRemote(status({ upstream: "team/x/main", remotes: [remote("team"), remote("team/x"), remote("origin")] })),
    ).toBe("team/x")
  })

  test("uses the only remote when there is no upstream", () => {
    expect(pushRemote(status({ remotes: [remote("origin")] }))).toBe("origin")
  })

  test("asks when there is no upstream and several remotes, or none", () => {
    expect(pushRemote(status({ remotes: [remote("origin"), remote("backup")] }))).toBeUndefined()
    expect(pushRemote(status())).toBeUndefined()
  })
})

describe("age", () => {
  const now = Date.UTC(2026, 10, 5, 12)

  test("picks the largest whole unit, and a date from 30 days on", () => {
    expect(age(now - 20_000, now)).toEqual({ unit: "now", count: 0 })
    expect(age(now - 5 * 60_000, now)).toEqual({ unit: "minutes", count: 5 })
    expect(age(now - 3 * 3_600_000, now)).toEqual({ unit: "hours", count: 3 })
    expect(age(now - 2 * 86_400_000, now)).toEqual({ unit: "days", count: 2 })
    expect(age(now - 30 * 86_400_000, now).unit).toBe("date")
  })

  test("treats a time in the future as now", () => {
    expect(age(now + 60_000, now).unit).toBe("now")
  })
})
