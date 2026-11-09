export * as ProjectVmBusy from "./busy.js"

import { execFile } from "node:child_process"
import { readdir, readFile } from "node:fs/promises"
import path from "node:path"
import { Duration, Effect, Schedule } from "effect"
import { PersistentPty } from "../persistent-pty/index.js"
import { SessionExecution } from "../session/execution.js"

export type Report = { busy: boolean; reasons: string[] }

export type Process = { pid: number; ppid: number; command: string }

// The preview counts as in use for this long after it served a request.
const PREVIEW_WINDOW_MS = 120_000

// What a terminal runs while it waits for input. Login shells are named with a leading dash.
const SHELLS = new Set(["bash", "zsh", "sh", "dash", "fish", "ash", "ksh", "login"])

// A MicroVM is one process serving one project, so these are process-wide.
const holds = new Map<string, number>()
const touches = new Map<string, number>()

/** Marks work in progress (an install, a publish) until the returned release runs; releasing twice is harmless. */
export function hold(reason: "install" | "publish") {
  holds.set(reason, (holds.get(reason) ?? 0) + 1)
  const state = { released: false }
  return () => {
    if (state.released) return
    state.released = true
    holds.set(reason, Math.max(0, (holds.get(reason) ?? 0) - 1))
  }
}

/** Records that the preview served a request. */
export function touch(reason: "preview", at = Date.now()) {
  touches.set(reason, at)
}

/**
 * What keeps this VM from pausing: running session steps, installs or publishes, a program running in a terminal (a
 * shell waiting for input doesn't count) and a preview someone viewed in the last 2 minutes.
 */
export function report(input: {
  sessions: number
  /** The terminals' own process IDs (their shells). */
  terminals: readonly number[]
  processes: readonly Process[]
  now?: number
}): Report {
  const now = input.now ?? Date.now()
  const byPid = new Map(input.processes.map((item) => [item.pid, item]))
  const running = input.terminals.flatMap((pid) => {
    const own = byPid.get(pid)
    if (!own) return []
    const child = input.processes.find((item) => item.ppid === pid)
    if (child) return [name(child.command)]
    return SHELLS.has(name(own.command)) ? [] : [name(own.command)]
  })
  const reasons = [
    ...(input.sessions > 0 ? [`sessions:${input.sessions}`] : []),
    ...[...holds].flatMap(([reason, count]) => (count > 0 ? [reason] : [])),
    ...(now - (touches.get("preview") ?? -Infinity) < PREVIEW_WINDOW_MS ? ["preview"] : []),
    ...running.map((command) => `terminal:${command}`),
  ]
  return { busy: reasons.length > 0, reasons }
}

/** Every process on this machine with its parent: from /proc on Linux (slim images have no `ps`), `ps` elsewhere. */
export async function processes(): Promise<Process[]> {
  if (process.platform === "linux") {
    const entries = (await readdir("/proc")).filter((entry) => /^\d+$/.test(entry))
    const rows = await Promise.all(entries.map((entry) => readFile(`/proc/${entry}/stat`, "utf8").catch(() => "")))
    return rows.flatMap((row) => {
      // "<pid> (<comm>) <state> <ppid> …"; the name may itself contain spaces or parentheses.
      const open = row.indexOf("(")
      const close = row.lastIndexOf(")")
      if (open < 0 || close < 0) return []
      const ppid = Number(row.slice(close + 2).split(" ")[1])
      return [{ pid: Number(row.slice(0, open).trim()), ppid, command: row.slice(open + 1, close) }]
    })
  }
  const text = await new Promise<string>((resolve, reject) =>
    execFile("ps", ["-A", "-o", "pid=,ppid=,comm="], { maxBuffer: 16 * 1024 * 1024 }, (error, stdout) =>
      error ? reject(error) : resolve(stdout),
    ),
  )
  return text.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line)
    return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), command: match[3]!.trim() }] : []
  })
}

/** This VM's report from its running sessions and terminals. */
export const current = Effect.gen(function* () {
  const execution = yield* SessionExecution.Service
  const ptys = yield* PersistentPty.Service
  const sessions = (yield* execution.active).size
  const terminals = (yield* ptys.list().pipe(Effect.orElseSucceed(() => []))).flatMap((info) =>
    info.status === "running" ? [info.pid] : [],
  )
  const table = terminals.length > 0 ? yield* Effect.promise(() => processes().catch(() => [])) : []
  return report({ sessions, terminals, processes: table })
})

/** Sends `read`'s report to the control plane every `intervalMs` (10 s); a failed send is logged and dropped. */
export const push = (input: {
  url: string
  projectID: string
  token: string
  read: Effect.Effect<Report>
  intervalMs?: number
}) => {
  const target = `${input.url.replace(/\/+$/, "")}/internal/projects/${encodeURIComponent(input.projectID)}/busy`
  const send = Effect.gen(function* () {
    const body = yield* input.read
    const response = yield* Effect.tryPromise(() =>
      fetch(target, {
        method: "POST",
        headers: { authorization: `Bearer ${input.token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(5_000),
      }),
    )
    if (!response.ok) yield* Effect.logWarning(`busy report push answered ${response.status}`)
  }).pipe(Effect.catchCause((cause) => Effect.logWarning("busy report push failed", cause)))
  return send.pipe(Effect.repeat(Schedule.spaced(Duration.millis(input.intervalMs ?? 10_000))), Effect.asVoid)
}

function name(command: string) {
  return path.basename(command.replace(/^-/, ""))
}
