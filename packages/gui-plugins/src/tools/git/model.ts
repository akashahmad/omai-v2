// What the Git panel derives from the repository's status: the header line, the file groups, whether a commit can be
// made, and the prompt that asks the agent to resolve conflicts.

import type { GitTool } from "@opencode/schema/git-tool"

export type Translate = (key: string, params?: Record<string, string | number>) => string

/** The header line, such as "main · origin/main · 2 ahead · 1 behind", or "main · not connected". */
export function summary(status: GitTool.Status, t: Translate) {
  if (!status.repo) return t("git.summary.notRepo")

  if (status.detached) return t("git.summary.detached")

  const tracking = !status.upstream
    ? [t("git.summary.noUpstream")]
    : [
        status.ahead > 0 ? t("git.summary.ahead", { count: status.ahead }) : undefined,
        status.behind > 0 ? t("git.summary.behind", { count: status.behind }) : undefined,
      ].filter((part) => part !== undefined)

  return [
    t("git.summary.branch", { branch: status.branch ?? "" }),
    status.upstream,
    ...(tracking.length ? tracking : [t("git.summary.synced")]),
    status.operation ? t(`git.summary.${status.operation}`) : undefined,
  ]
    .filter((part) => part !== undefined)
    .join(" · ")
}

/** A file with both staged and unstaged edits appears in both lists. */
export function groups(files: readonly GitTool.FileChange[]) {
  return {
    staged: files.filter((file) => file.state !== "conflicted" && file.staged),
    changes: files.filter((file) => file.state !== "conflicted" && file.unstaged),
    conflicted: files.filter((file) => file.state === "conflicted"),
  }
}

/**
 * The paths to send for files. Unstaging or discarding a rename must include the old path, or half of it stays behind;
 * staging must not, because the old path no longer exists in the working tree and git rejects the pathspec.
 */
export function pathsOf(files: readonly GitTool.FileChange[], withOldPath: boolean) {
  return files.flatMap((file) => (withOldPath && file.oldPath ? [file.path, file.oldPath] : [file.path]))
}

export function canCommit(status: GitTool.Status, message: string) {
  return (
    message.trim().length > 0 &&
    !!status.profile.name &&
    !!status.profile.email &&
    groups(status.files).conflicted.length === 0 &&
    groups(status.files).staged.length > 0
  )
}

export function resolvePrompt(files: readonly GitTool.FileChange[]) {
  return [
    "These files have merge conflicts. Resolve each one, keeping the intent of both sides, then stage them.",
    "",
    "```text",
    ...files.map((file) => file.path),
    "```",
  ].join("\n")
}

/**
 * The remote a push goes to without asking: the upstream's remote, else the only remote. Undefined when there is no
 * upstream and several remotes, so the user picks.
 */
export function pushRemote(status: GitTool.Status) {
  const upstream = status.upstream

  // Remote names may contain "/", so the longest name that prefixes the upstream wins.
  const tracked = upstream
    ? status.remotes
        .filter((remote) => upstream.startsWith(`${remote.name}/`))
        .toSorted((a, b) => b.name.length - a.name.length)[0]
    : undefined

  if (tracked) return tracked.name

  return status.remotes.length === 1 ? status.remotes[0]?.name : undefined
}

const MS = { minute: 60_000, hour: 3_600_000, day: 86_400_000 }

/** How long ago a time was, in the largest whole unit; a month or more shows as a date instead. */
export function age(time: number, now: number) {
  const elapsed = Math.max(0, now - time)

  if (elapsed < MS.minute) return { unit: "now" as const, count: 0 }

  if (elapsed < MS.hour) return { unit: "minutes" as const, count: Math.floor(elapsed / MS.minute) }

  if (elapsed < MS.day) return { unit: "hours" as const, count: Math.floor(elapsed / MS.hour) }

  if (elapsed < 30 * MS.day) return { unit: "days" as const, count: Math.floor(elapsed / MS.day) }

  return { unit: "date" as const, count: 0 }
}
