import type { GitTool } from "@opencode/schema/git-tool"
import { classify, runGit } from "./run.js"
import { GitError, maskText, parseNumstat, readStatus, requireRoot, succeed, summarize, TIMED_OUT } from "./status.js"

type Output = { code: number; stdout: string; stderr: string }

const SYNC_TIMEOUT = 60_000
const commitFormat = ["%H", "%h", "%s", "%b", "%an", "%ae", "%ct", "%P"].join("%x1f") + "%x1e"

export async function commit(cwd: string, input: { message: string; amend?: boolean }): Promise<GitTool.Result> {
  const root = await requireRoot(cwd)
  const git = (...args: string[]) => runGit({ cwd: root, args })
  const message = input.message.trim()
  if (!message) throw new GitError("other", "Write a message for this commit", "")
  if (input.amend) {
    const pushed = await git("branch", "-r", "--contains", "HEAD")
    if (pushed.code === 0 && pushed.stdout.trim()) throw new GitError("other", "The last commit has already been pushed", "")
  }
  // Concluding a merge is allowed even when the resolved index equals HEAD.
  const merging = (await readStatus(root)).operation === "merge"
  if (!input.amend && !merging && (await git("diff", "--cached", "--quiet")).code === 0)
    throw new GitError("nothing-to-commit", "Nothing is staged to commit", "")
  // Git can invent an identity from the hostname, so check for a real one first.
  const name = await git("config", "user.name")
  const email = await git("config", "user.email")
  if (!name.stdout.trim() || !email.stdout.trim())
    throw new GitError("no-profile", "Set your name and email before committing", "")
  fail(await git("commit", ...(input.amend ? ["--amend"] : []), "-m", message))
  return { message: `Committed “${message.split("\n")[0]}”` }
}

export async function setProfile(cwd: string, input: { name: string; email: string; global: boolean }) {
  const name = input.name.trim()
  const email = input.email.trim()
  if (!name || !email) throw new GitError("other", "Enter both a name and an email", "")
  const scope = input.global ? ["--global"] : []
  succeed(await runGit({ cwd, args: ["config", ...scope, "user.name", name] }))
  succeed(await runGit({ cwd, args: ["config", ...scope, "user.email", email] }))
}

export async function push(cwd: string, input: { remote?: string }): Promise<GitTool.Result> {
  const root = await requireRoot(cwd)
  const git = (...args: string[]) => runGit({ cwd: root, args, timeout: SYNC_TIMEOUT })
  const track = await tracking(root)
  if (!track.branch) throw new GitError("other", "Switch to a branch before pushing", "")
  const remotes = (await git("remote")).stdout.split("\n").filter(Boolean)
  const remote = input.remote ?? track.remote ?? (remotes.includes("origin") ? "origin" : remotes[0])
  if (!remote || !remotes.includes(remote)) throw new GitError("no-remote", "Add a remote before pushing", "")
  const upstream = track.remote === remote ? track.upstream : undefined
  // A branch can track a differently named branch, and that is where its commits belong.
  const branch = upstream ? upstream.slice(remote.length + 1) : track.branch
  const target = `${remote}/${branch}`
  const range = upstream ? [`${upstream}..HEAD`] : ["HEAD", "--not", `--remotes=${remote}`]
  const count = Number((await git("rev-list", "--count", ...range)).stdout.trim()) || 0
  const pushed = await git("push", ...(upstream ? [] : ["--set-upstream"]), remote, `HEAD:${branch}`)
  fail(pushed, { host: await hostOf(root, remote), upstream: target })
  if (count === 0) return { message: "Already up to date" }
  return { message: `Pushed ${commits(count)} to ${target}` }
}

export async function pull(cwd: string, input: { mode?: "ff-only" | "rebase" | "merge" }): Promise<GitTool.Result> {
  const root = await requireRoot(cwd)
  const git = (...args: string[]) => runGit({ cwd: root, args, timeout: SYNC_TIMEOUT })
  const track = await tracking(root)
  if (!track.upstream || !track.remote) throw new GitError("no-upstream", "This branch has no upstream to pull from", "")
  const context = { host: await hostOf(root, track.remote), upstream: track.upstream }
  fail(await git("fetch", track.remote), context)
  const behind = Number((await git("rev-list", "--count", `HEAD..${track.upstream}`)).stdout.trim()) || 0
  if (behind === 0) return { message: "Already up to date" }
  const mode = { "ff-only": "--ff-only", rebase: "--rebase", merge: "--no-rebase" }[input.mode ?? "ff-only"]
  const pulled = await git("pull", mode, "--no-edit", track.remote, track.upstream.slice(track.remote.length + 1))
  if (pulled.code !== 0 && classify(`${pulled.stdout}\n${pulled.stderr}`) === "conflict") {
    const files = (await git("diff", "--name-only", "--diff-filter=U")).stdout.split("\n").filter(Boolean).length
    throw new GitError("conflict", `Pulling stopped on conflicts in ${files} file${files === 1 ? "" : "s"}`, maskText(pulled.stderr.trim() || pulled.stdout.trim()))
  }
  fail(pulled, context)
  return { message: `Pulled ${commits(behind)}` }
}

export async function fetch(cwd: string): Promise<GitTool.Result> {
  const root = await requireRoot(cwd)
  const git = (...args: string[]) => runGit({ cwd: root, args, timeout: SYNC_TIMEOUT })
  const remotes = (await git("remote")).stdout.split("\n").filter(Boolean)
  if (remotes.length === 0) throw new GitError("no-remote", "Add a remote before fetching", "")
  fail(await git("fetch", "--all", "--prune"), { host: await hostOf(root, remotes[0]) })
  return { message: "Fetched the latest changes" }
}

export async function abort(cwd: string): Promise<GitTool.Result> {
  const root = await requireRoot(cwd)
  const operation = (await readStatus(root)).operation
  if (!operation) throw new GitError("other", "There is nothing to stop", "")
  succeed(await runGit({ cwd: root, args: [operation, "--abort"] }))
  return { message: `Stopped the ${operation}` }
}

/** Finishes a rebase or merge once every conflict is resolved and staged, without opening an editor. */
export async function continueOperation(cwd: string): Promise<GitTool.Result> {
  const root = await requireRoot(cwd)
  // core.editor and GIT_EDITOR both accept git's prepared message, so nothing waits for an editor that never opens.
  const git = (...args: string[]) => runGit({ cwd: root, args: ["-c", "core.editor=true", ...args], env: { GIT_EDITOR: "true" } })
  const operation = (await readStatus(root)).operation
  if (!operation) throw new GitError("other", "There is nothing to continue", "")
  const unmerged = await conflicted(root)
  if (unmerged > 0) throw new GitError("conflict", `Resolve the conflicts in ${files(unmerged)} first`, "")
  const result = operation === "rebase" ? await git("rebase", "--continue") : await git("commit", "--no-edit")
  // A rebase replays the next commit at once, which can stop on new conflicts.
  if (result.code !== 0 && operation === "rebase" && (await conflicted(root)) > 0)
    throw new GitError("conflict", "The rebase stopped on conflicts in the next commit", maskText(result.stderr.trim() || result.stdout.trim()))
  fail(result)
  return { message: operation === "rebase" ? "Finished the rebase" : "Finished the merge" }
}

export async function remoteAdd(cwd: string, input: { name: string; url: string }) {
  const root = await requireRoot(cwd)
  requireRemote(input)
  succeed(await runGit({ cwd: root, args: ["remote", "add", "--", input.name, input.url.trim()] }))
}

export async function remoteSet(cwd: string, input: { name: string; url: string }) {
  const root = await requireRoot(cwd)
  requireRemote(input)
  succeed(await runGit({ cwd: root, args: ["remote", "set-url", "--", input.name, input.url.trim()] }))
}

export async function remoteRemove(cwd: string, name: string) {
  const root = await requireRoot(cwd)
  succeed(await runGit({ cwd: root, args: ["remote", "remove", "--", name] }))
}

export async function branchCreate(cwd: string, name: string) {
  const root = await requireRoot(cwd)
  await requireBranchName(root, name)
  succeed(await runGit({ cwd: root, args: ["switch", "-c", name] }))
}

export async function branchSwitch(cwd: string, name: string) {
  const root = await requireRoot(cwd)
  await requireBranchName(root, name)
  succeed(await runGit({ cwd: root, args: ["switch", name] }))
}

export async function log(cwd: string, input: { skip?: number; limit?: number }) {
  const root = await requireRoot(cwd)
  const limit = input.limit ?? 20
  const result = await runGit({
    cwd: root,
    args: [
      "log",
      `--format=${commitFormat}`,
      `-n${limit + 1}`,
      // Offset from HEAD: resuming from the last commit shown would lose the other side of a merge.
      `--skip=${Math.max(0, Math.floor(input.skip ?? 0))}`,
      "--",
    ],
  })
  if (result.code !== 0 && /does not have any commits yet/.test(result.stderr)) return { commits: [], more: false }
  succeed(result)
  const all = parseCommits(result.stdout)
  return { commits: all.slice(0, limit), more: all.length > limit }
}

export async function show(cwd: string, hash: string) {
  const root = await requireRoot(cwd)
  requireHash(hash)
  const git = (...args: string[]) => runGit({ cwd: root, args })
  const meta = await git("show", "-s", `--format=${commitFormat}`, hash, "--")
  succeed(meta)
  const commit = parseCommits(meta.stdout)[0]
  const parent = (await git("rev-list", "--parents", "-n1", commit.hash)).stdout.trim().split(" ")[1]
  const range = parent ? [parent, commit.hash] : ["--root", commit.hash]
  const status = await git("diff-tree", "-r", "-z", "-M", "--no-commit-id", "--name-status", ...range)
  succeed(status)
  const numstat = await git("diff-tree", "-r", "-z", "-M", "--no-commit-id", "--numstat", ...range)
  succeed(numstat)
  const counts = parseNumstat(numstat.stdout)
  const tokens = status.stdout.split("\0").filter(Boolean)
  const files: GitTool.FileChange[] = []
  for (let index = 0; index < tokens.length; ) {
    const code = tokens[index++]
    const renamed = code.startsWith("R") || code.startsWith("C")
    const oldPath = renamed ? tokens[index++] : undefined
    const file = tokens[index++]
    const count = counts.find((item) => item.path === file)
    files.push({
      path: file,
      ...(oldPath ? { oldPath } : {}),
      state: code.startsWith("A") ? "added" : code.startsWith("D") ? "deleted" : code.startsWith("R") ? "renamed" : "modified",
      staged: false,
      unstaged: false,
      additions: count?.additions ?? 0,
      deletions: count?.deletions ?? 0,
    })
  }
  return { commit, files }
}

export async function init(cwd: string) {
  if ((await runGit({ cwd, args: ["rev-parse", "--show-toplevel"] })).code === 0) return
  succeed(await runGit({ cwd, args: ["init", "-b", "main"] }))
}

async function tracking(root: string) {
  const head = await runGit({ cwd: root, args: ["symbolic-ref", "--short", "-q", "HEAD"] })
  const branch = head.code === 0 ? head.stdout.trim() : undefined
  if (!branch) return {}
  const info = await runGit({
    cwd: root,
    args: ["for-each-ref", "--format=%(upstream:short)%09%(upstream:remotename)", `refs/heads/${branch}`],
  })
  const parts = info.stdout.trimEnd().split("\t")
  return { branch, upstream: parts[0] || undefined, remote: parts[1] || undefined }
}

async function hostOf(root: string, remote: string) {
  const url = await runGit({ cwd: root, args: ["remote", "get-url", remote] })
  const text = url.stdout.trim()
  return /^[a-z][a-z0-9+.-]*:\/\/(?:[^/@]*@)?([^/:]+)/i.exec(text)?.[1] ?? /^(?:[^@/]+@)?([^:/]+):/.exec(text)?.[1] ?? remote
}

/** Turns a failed git run into a GitError with a plain-language message and git's raw output as details. */
function fail(result: Output, context: { host?: string; upstream?: string } = {}) {
  if (result.code === 0) return
  if (result.code === 124) throw new GitError("other", TIMED_OUT, "")
  const text = `${result.stdout}\n${result.stderr}`
  const kind = classify(text)
  const details = maskText(result.stderr.trim() || result.stdout.trim())
  if (kind === "auth" && context.host)
    throw new GitError(kind, `${context.host} needs you to sign in with Git on this computer`, details)
  if (kind === "diverged" && context.upstream)
    throw new GitError(kind, `Your branch and ${context.upstream} have both changed`, details)
  throw new GitError(kind, summarize(details), details)
}

async function conflicted(root: string) {
  return (await runGit({ cwd: root, args: ["diff", "--name-only", "--diff-filter=U"] })).stdout.split("\n").filter(Boolean).length
}

function files(count: number) {
  return `${count} file${count === 1 ? "" : "s"}`
}

function commits(count: number) {
  return `${count} commit${count === 1 ? "" : "s"}`
}

function requireRemote(input: { name: string; url: string }) {
  if (!/^[A-Za-z0-9_][A-Za-z0-9._-]*$/.test(input.name) || input.name.includes("..") || input.name.endsWith(".lock") || input.name.endsWith("."))
    throw new GitError("other", "Remote names use letters, numbers, dots, dashes and underscores", input.name)
  const url = input.url.trim()
  if (!url || url.startsWith("-") || /\s/.test(url)) throw new GitError("other", "Enter a valid remote address", input.url)
}

async function requireBranchName(root: string, name: string) {
  const checked = await runGit({ cwd: root, args: ["check-ref-format", "--branch", name] })
  if (checked.code !== 0) throw new GitError("other", "That is not a valid branch name", name)
}

function requireHash(hash: string) {
  if (!/^[0-9a-f]{4,64}$/i.test(hash)) throw new GitError("other", "Invalid commit", hash)
}

function parseCommits(output: string): GitTool.Commit[] {
  return output
    .split("\x1e")
    .map((record) => record.replace(/^\n/, ""))
    .filter(Boolean)
    .map((record) => record.split("\x1f"))
    .map((parts) => ({
      hash: parts[0],
      short: parts[1],
      subject: parts[2],
      body: parts[3].trim(),
      author: parts[4],
      email: parts[5],
      time: Number(parts[6]) * 1000,
      merge: parts[7].split(" ").filter(Boolean).length > 1,
    }))
}
