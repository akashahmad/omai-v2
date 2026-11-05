import { access, readFile, rm, stat } from "node:fs/promises"
import path from "node:path"
import type { GitTool } from "@opencode/schema/git-tool"
import { classify, runGit } from "./run.js"

export class GitError extends Error {
  constructor(
    readonly kind: GitTool.FailureKind,
    message: string,
    readonly details: string,
  ) {
    super(message)
  }
}

type Change = Omit<GitTool.FileChange, "additions" | "deletions">

const empty = {
  repo: false,
  detached: false,
  ahead: 0,
  behind: 0,
  files: [],
  remotes: [],
  branches: [],
  profile: { scope: "none" },
} as const satisfies GitTool.Status

export async function readStatus(cwd: string): Promise<GitTool.Status> {
  const top = await runGit({ cwd, args: ["rev-parse", "--show-toplevel"] })
  if (top.code !== 0) return empty
  const root = top.stdout.trim()
  // A status read must not take the index lock, which would fail the user's own commit running at the same time.
  const git = (...args: string[]) => runGit({ cwd: root, args, env: { GIT_OPTIONAL_LOCKS: "0" } })
  const [porcelain, unstaged, staged, config, remote, branch, dir] = await Promise.all([
    git("status", "--porcelain=v2", "-z", "--branch", "--untracked-files=all"),
    git("diff", "--numstat", "-z"),
    git("diff", "--numstat", "-z", "--cached"),
    git("config", "--show-scope", "--get-regexp", "^user\\.(name|email)$"),
    git("remote", "-v"),
    git("branch", "--format=%(refname:short)%09%(HEAD)%09%(upstream:short)"),
    git("rev-parse", "--absolute-git-dir"),
  ])
  // Only status is fatal: a failed status must not look like a clean tree. The other reads degrade to empty.
  succeed(porcelain)
  const parsed = parsePorcelain(porcelain.stdout)
  const counts = [...parseNumstat(unstaged.stdout), ...parseNumstat(staged.stdout)]
  // A huge untracked tree (a missing .gitignore) is listed without line counts rather than read file by file.
  const countUntracked = parsed.files.filter((file) => file.state === "untracked").length <= MAX_COUNTED
  const limit = createLimit(READ_PARALLELISM)
  const files = await Promise.all(
    parsed.files.map(async (file) => {
      if (file.state === "untracked")
        return {
          ...file,
          additions: countUntracked ? await limit(() => countLines(path.join(root, file.path))) : 0,
          deletions: 0,
        }
      const mine = counts.filter((count) => count.path === file.path)
      return {
        ...file,
        additions: mine.reduce((sum, count) => sum + count.additions, 0),
        deletions: mine.reduce((sum, count) => sum + count.deletions, 0),
      }
    }),
  )
  const remotes = parseRemotes(remote.stdout)
  const pushRemote =
    remotes.find((name) => parsed.upstream?.startsWith(`${name.name}/`))?.name ??
    remotes.find((name) => name.name === "origin")?.name ??
    remotes[0]?.name

  return {
    repo: true,
    root,
    branch: parsed.branch,
    detached: parsed.detached,
    upstream: parsed.upstream,
    ahead: parsed.ahead,
    behind: parsed.behind,
    files,
    remotes: remotes.map((item) => ({ ...item, push: item.name === pushRemote })),
    branches: branch.stdout
      .split("\n")
      .filter((line) => line && !line.startsWith("("))
      .map((line) => line.split("\t"))
      .map((parts) => ({
        name: parts[0],
        current: parts[1] === "*",
        ...(parts[2] ? { upstream: parts[2] } : {}),
      })),
    profile: parseProfile(config.stdout),
    operation: await readOperation(dir.stdout.trim()),
  }
}

export async function fileDiff(cwd: string, input: { path: string; oldPath?: string; staged?: boolean; commit?: string }) {
  if (input.commit && !/^[0-9a-f]{4,64}$/i.test(input.commit))
    throw new GitError("other", "Invalid commit", input.commit)
  const root = await requireRoot(cwd)
  const show = async (spec: string) => {
    const result = await runGit({ cwd: root, args: ["show", spec] })
    return result.code === 0 ? result.stdout : ""
  }
  const worktree = async () => {
    return readFile(inside(root, input.path), "utf8").catch(() => "")
  }
  // A rename's "before" is the file under its old name.
  const old = input.oldPath ?? input.path
  const [before, after] = input.commit
    ? await Promise.all([show(`${input.commit}^:${old}`), show(`${input.commit}:${input.path}`)])
    : input.staged
      ? await Promise.all([show(`HEAD:${old}`), show(`:${input.path}`)])
      : await Promise.all([show(`:${input.path}`), worktree()])
  if (before.includes("\0") || after.includes("\0")) return { before: "", after: "", binary: true }
  return { before, after, binary: false }
}

export async function stage(cwd: string, paths: string[], staged: boolean) {
  if (paths.length === 0) return
  const root = await requireRoot(cwd)
  if (staged) return succeed(await runGit({ cwd: root, args: ["--literal-pathspecs", "add", "-A", "--", ...paths] }))
  const head = await runGit({ cwd: root, args: ["rev-parse", "--verify", "-q", "HEAD"] })
  // Without a first commit there is no HEAD to restore the index from.
  const args =
    head.code === 0
      ? ["restore", "--staged", "--", ...paths]
      : ["rm", "--cached", "-r", "-f", "-q", "--ignore-unmatch", "--", ...paths]
  succeed(await runGit({ cwd: root, args: ["--literal-pathspecs", ...args] }))
}

export async function discard(cwd: string, input: string[]) {
  if (input.length === 0) return
  const root = await requireRoot(cwd)
  const files = input.map((item) => inside(root, item))
  const folders = await Promise.all(files.map((file) => stat(file).then((info) => info.isDirectory(), () => false)))
  if (folders.some(Boolean)) throw new GitError("other", "Choose files, not folders, to discard", input.join("\n"))
  const paths = files.map((file) => path.relative(root, file).split(path.sep).join("/"))
  const tracked = await runGit({ cwd: root, args: ["--literal-pathspecs", "ls-tree", "-r", "-z", "--name-only", "HEAD", "--", ...paths] })
  const known = new Set(tracked.code === 0 ? tracked.stdout.split("\0") : [])
  const restore = paths.filter((item) => known.has(item))
  const remove = paths.filter((item) => !known.has(item))
  if (restore.length > 0)
    succeed(await runGit({ cwd: root, args: ["--literal-pathspecs", "restore", "--source=HEAD", "--staged", "--worktree", "--", ...restore] }))
  if (remove.length === 0) return
  // Untracked files and files added but never committed: unstage, then delete.
  succeed(await runGit({ cwd: root, args: ["--literal-pathspecs", "rm", "--cached", "-r", "-f", "-q", "--ignore-unmatch", "--", ...remove] }))
  await Promise.all(remove.map((item) => rm(path.join(root, item), { force: true })))
}

// Greedy on purpose: a password may itself contain "@", and the last one ends the userinfo.
const userinfo = /([a-z][a-z0-9+.-]*:\/\/)[^/\s]*@/

export function maskUrl(url: string) {
  return url.replace(new RegExp(`^${userinfo.source}`, "i"), "$1***@")
}

export async function requireRoot(cwd: string) {
  const top = await runGit({ cwd, args: ["rev-parse", "--show-toplevel"] })
  if (top.code !== 0) throw new GitError("not-a-repo", "Not a git repository", top.stderr)
  return top.stdout.trim()
}

export const TIMED_OUT = "Git took too long and was stopped"

export function succeed(result: { code: number; stderr: string }) {
  if (result.code === 0) return
  if (result.code === 124) throw new GitError("other", TIMED_OUT, "")
  throw new GitError(classify(result.stderr), summarize(result.stderr), maskText(result.stderr))
}

/** The first meaningful line of git's output, without its "fatal: " or "error: " prefix, with credentials masked. */
export function summarize(output: string) {
  const line = output.split("\n").find((item) => item.trim() && !item.startsWith("hint:")) ?? "Git failed"
  return maskText(line.trim().replace(/^(fatal|error): /, ""))
}

/** Masks credentials in every URL of free-form git output. */
export function maskText(text: string) {
  return text.replace(new RegExp(userinfo.source, "gi"), "$1***@")
}

function inside(root: string, file: string) {
  const full = path.resolve(root, file)
  if (full !== root && !full.startsWith(root + path.sep)) throw new GitError("other", "Path is outside the repository", file)
  return full
}

const MAX_COUNTED = 500
const MAX_COUNTED_BYTES = 1024 * 1024
const READ_PARALLELISM = 16

/** Runs the tasks it is given at most `size` at a time. */
function createLimit(size: number) {
  const waiting: (() => void)[] = []
  let running = 0

  return async <A>(task: () => Promise<A>) => {
    if (running >= size) await new Promise<void>((resolve) => waiting.push(resolve))
    running++
    try {
      return await task()
    } finally {
      running--
      waiting.shift()?.()
    }
  }
}

async function countLines(file: string) {
  const info = await stat(file).catch(() => undefined)
  if (!info?.isFile() || info.size > MAX_COUNTED_BYTES) return 0
  const text = await readFile(file, "utf8").catch(() => "")
  if (text.length === 0 || text.includes("\0")) return 0
  return text.split("\n").length - (text.endsWith("\n") ? 1 : 0)
}

function parsePorcelain(output: string) {
  const records = output.split("\0")
  const files: Change[] = []
  const header = { branch: undefined as string | undefined, detached: false, upstream: undefined as string | undefined, ahead: 0, behind: 0 }
  let index = 0
  while (index < records.length) {
    const record = records[index++]
    if (record.startsWith("# branch.head ")) {
      const name = record.slice("# branch.head ".length)
      header.detached = name === "(detached)"
      header.branch = header.detached ? undefined : name
    }
    if (record.startsWith("# branch.upstream ")) header.upstream = record.slice("# branch.upstream ".length)
    if (record.startsWith("# branch.ab ")) {
      const match = /\+(\d+) -(\d+)/.exec(record)
      header.ahead = Number(match?.[1] ?? 0)
      header.behind = Number(match?.[2] ?? 0)
    }
    if (record.startsWith("? ")) files.push({ path: record.slice(2), state: "untracked", staged: false, unstaged: true })
    if (record.startsWith("1 ")) files.push(change(record.split(" ", 8)[1], record.split(" ").slice(8).join(" ")))
    if (record.startsWith("2 ")) {
      const fields = record.split(" ")
      files.push({ ...change(fields[1], fields.slice(9).join(" ")), oldPath: records[index++] })
    }
    if (record.startsWith("u "))
      files.push({ path: record.split(" ").slice(10).join(" "), state: "conflicted", staged: false, unstaged: true })
  }
  return { ...header, files }
}

function change(xy: string, file: string): Change {
  const index = xy[0]
  const tree = xy[1]
  const state =
    index === "R" || tree === "R"
      ? "renamed"
      : index === "A"
        ? "added"
        : index === "D" || tree === "D"
          ? "deleted"
          : "modified"
  return { path: file, state, staged: index !== ".", unstaged: tree !== "." }
}

export function parseNumstat(output: string) {
  const tokens = output.split("\0")
  const counts: { path: string; additions: number; deletions: number }[] = []
  let index = 0
  while (index < tokens.length) {
    const match = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(tokens[index++])
    if (!match) continue
    // A rename lists an empty path, then the old and new paths as separate records.
    const file = match[3] === "" ? (index++, tokens[index++]) : match[3]
    counts.push({ path: file, additions: Number(match[1]) || 0, deletions: Number(match[2]) || 0 })
  }
  return counts
}

function parseRemotes(output: string) {
  return output
    .split("\n")
    .filter((line) => line.endsWith("(fetch)"))
    .map((line) => /^(\S+)\t(.*) \(fetch\)$/.exec(line))
    .flatMap((match) => (match ? [{ name: match[1], url: maskUrl(match[2]) }] : []))
}

function parseProfile(output: string): GitTool.Profile {
  const values = output
    .split("\n")
    .flatMap((line) => {
      const match = /^(\S+)\t(user\.(?:name|email)) ?(.*)$/.exec(line)
      return match ? [{ scope: match[1], key: match[2], value: match[3] }] : []
    })
  const last = (key: string) => values.findLast((item) => item.key === key)
  const name = last("user.name")
  const email = last("user.email")
  const set = [name, email].flatMap((item) => (item ? [item] : []))
  if (set.length === 0) return { scope: "none" }
  return {
    ...(name ? { name: name.value } : {}),
    ...(email ? { email: email.value } : {}),
    scope: set.some((item) => item.scope === "local" || item.scope === "worktree") ? "local" : "global",
  }
}

async function readOperation(dir: string) {
  const exists = (name: string) => access(path.join(dir, name)).then(() => true, () => false)
  if (await exists("MERGE_HEAD")) return "merge" as const
  if ((await exists("rebase-merge")) || (await exists("rebase-apply"))) return "rebase" as const
  return undefined
}
