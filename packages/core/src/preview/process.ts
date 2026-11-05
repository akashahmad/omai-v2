// Runs a dev server in its own process group and decides when it is ready.

import { spawn } from "node:child_process"
import { request } from "node:http"
import { LOG_BUFFER, PROBE_INTERVAL, PROBE_TIMEOUT, START_TIMEOUT, STOP_GRACE } from "./limits.js"
import { listeningPorts, logPorts } from "./ports.js"

export interface Running {
  readonly pid: number
  /** Resolves with the exit code, or null when a signal ended it. */
  readonly exited: Promise<number | null>
  /** SIGTERM to the whole group, then SIGKILL after the grace period. Resolves once the group leader is gone. */
  stop(): Promise<void>
}

/** Starts `command` with `sh -c` as the leader of a new process group, so stopping it reaches every child. */
export function spawnGroup(input: {
  command: string
  cwd: string
  env: Record<string, string>
  onLog: (chunk: string) => void
}): Running {
  const child = spawn("sh", ["-c", input.command], {
    cwd: input.cwd,
    env: input.env,
    detached: true,
    // A closed stdin makes interactive prompts fail instead of waiting forever.
    stdio: ["ignore", "pipe", "pipe"],
  })
  const exited = new Promise<number | null>((resolve) => {
    child.once("exit", (code) => resolve(code))
    // A spawn failure (no shell, bad cwd) is reported once, as an exit.
    child.once("error", (cause) => {
      input.onLog(`${cause.message}\n`)
      resolve(-1)
    })
  })
  child.stdout?.on("data", (data: Buffer) => input.onLog(data.toString()))
  child.stderr?.on("data", (data: Buffer) => input.onLog(data.toString()))
  const pid = child.pid ?? -1

  return {
    pid,
    exited,
    stop: async () => {
      signal(pid, "SIGTERM")
      const done = await Promise.race([exited.then(() => true), sleep(STOP_GRACE).then(() => false)])

      if (!done) signal(pid, "SIGKILL")
      // Children outside the leader's lifetime still share its group.
      signal(pid, "SIGKILL")
      await exited
    },
  }
}

function signal(pid: number, name: NodeJS.Signals) {
  if (pid <= 0) return

  try {
    process.kill(-pid, name)
  } catch {
    // Already gone.
  }
}

/** The last `LOG_BUFFER` characters of a process's output. */
export class LogBuffer {
  private value = ""

  append(chunk: string) {
    this.value = (this.value + chunk).slice(-LOG_BUFFER)
  }

  text() {
    return this.value
  }

  tail(size: number) {
    return this.value.slice(-size)
  }

  clear() {
    this.value = ""
  }
}

export type Ready = { ok: true; port: number } | { ok: false; reason: string }

// A port that answers without HTML is accepted only after this many rounds without an HTML answer elsewhere, so an
// API on the assigned port does not win over the page a moment before the page comes up.
const PATIENCE = 3

/**
 * Waits until a port of the dev server answers HTTP. Candidates are the ports its process tree listens on, local
 * ports its log mentions, and the assigned port; one answering with HTML wins.
 */
export async function waitReady(input: {
  running: Running
  assigned: number
  log: () => string
  signal: AbortSignal
  timeout?: number
}): Promise<Ready> {
  const deadline = Date.now() + (input.timeout ?? START_TIMEOUT)
  const exited = input.running.exited.then((code) => ({ code }))
  const quiet = new Map<number, number>()

  while (Date.now() < deadline) {
    if (input.signal.aborted) return { ok: false, reason: "The start was cancelled." }
    const ended = await Promise.race([exited, Promise.resolve(undefined)])

    if (ended)
      return { ok: false, reason: `The dev server exited${ended.code === null ? "" : ` with code ${ended.code}`}.` }
    const candidates = [
      ...new Set([...(await listeningPorts(input.running.pid)), ...logPorts(input.log()), input.assigned]),
    ]
    const answers = await Promise.all(candidates.map(async (port) => ({ port, answer: await probe(port) })))
    const html = answers.find((item) => item.answer === "html")

    if (html) return { ok: true, port: html.port }
    const other = answers.find((item) => item.answer === "other" && (quiet.get(item.port) ?? 0) + 1 >= PATIENCE)

    if (other) return { ok: true, port: other.port }
    answers
      .filter((item) => item.answer === "other")
      .forEach((item) => quiet.set(item.port, (quiet.get(item.port) ?? 0) + 1))
    const finished = await Promise.race([exited, sleep(PROBE_INTERVAL).then(() => undefined)])

    if (finished)
      return {
        ok: false,
        reason: `The dev server exited${finished.code === null ? "" : ` with code ${finished.code}`}.`,
      }
  }

  return { ok: false, reason: "The dev server didn't start in time." }
}

/** Whether a local port answers HTTP, and with HTML. Any status counts: a 404 still means a server is there. */
function probe(port: number) {
  return new Promise<"html" | "other" | undefined>((resolve) => {
    const req = request(
      { host: "127.0.0.1", port, path: "/", method: "GET", timeout: PROBE_TIMEOUT, headers: { accept: "text/html" } },
      (res) => {
        res.resume()
        resolve(String(res.headers["content-type"] ?? "").includes("text/html") ? "html" : "other")
      },
    )
    req.once("timeout", () => req.destroy())
    req.once("error", () => resolve(undefined))
    req.end()
  })
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
