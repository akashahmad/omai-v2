import { createStore, reconcile } from "solid-js/store"
import type { MountedSession } from "@opencode/plugin/gui"
import type { Files } from "@opencode/schema/files"
import { base64ToBytes } from "@opencode/util/base64"

/** What a download fetches: the whole project, one folder as a zip, or one file. */
export type DownloadTarget = { readonly kind: "project" } | { readonly kind: "folder" | "file"; readonly path: string }

export type DownloadState = {
  readonly name: string
  /** `scanning` and `zipping` run on the server; `downloading` moves the bytes to the browser. */
  readonly phase: "scanning" | "zipping" | "downloading" | "failed"
  /** Progress from 0 to 1 within the phase; undefined while it can't be measured yet. */
  readonly progress?: number
  readonly files?: number
  readonly total?: number
  readonly error?: string
}

type Job = { abort: AbortController; release?: () => void }

/** Downloads per session and target, owned by the file plugin's setup so they keep going while the panel is closed. */
export function createDownloads(input: { failed(name: string, error: string): void }) {
  const [state, setState] = createStore<Record<string, DownloadState | undefined>>({})
  const jobs = new Map<string, Job>()

  const id = (session: MountedSession, target: DownloadTarget) =>
    `${session.key}\n${target.kind === "project" ? "" : `${target.kind}:${target.path}`}`

  const set = (key: string, next: DownloadState | undefined) =>
    setState(key, next === undefined ? undefined : reconcile(next))

  const start = (session: MountedSession, target: DownloadTarget, name: string) => {
    const key = id(session, target)

    if (jobs.has(key)) return
    const job: Job = { abort: new AbortController() }
    jobs.set(key, job)

    const report = (next: DownloadState) => {
      if (!job.abort.signal.aborted) set(key, next)
    }

    report({ name, phase: target.kind === "file" ? "downloading" : "scanning" })
    void run(session, target, name, job, report)
      .then(() => set(key, undefined))
      .catch((error: Failure) => {
        if (job.abort.signal.aborted) return
        const message = describe(error)
        set(key, { name, phase: "failed", error: message })
        input.failed(name, message)
      })
      .finally(() => {
        job.release?.()

        if (jobs.get(key) === job) jobs.delete(key)
      })
  }

  const cancel = (session: MountedSession, target: DownloadTarget) => {
    const key = id(session, target)
    jobs.get(key)?.abort.abort()
    jobs.delete(key)
    set(key, undefined)
  }

  return {
    /** The download's state; undefined when none runs or failed. Reactive. */
    get: (session: MountedSession, target: DownloadTarget) => state[id(session, target)],
    start,
    cancel,
    /** Cancels every download, for the plugin's teardown. */
    dispose: () => {
      jobs.forEach((job) => job.abort.abort())
      jobs.clear()
    },
  }
}

async function run(
  session: MountedSession,
  target: DownloadTarget,
  name: string,
  job: Job,
  report: (state: DownloadState) => void,
) {
  const { Files } = await import("@opencode/schema/files")
  const signal = job.abort.signal
  const rpc = session.server.client.rpc(Files.Definition)
  const options = { location: { directory: session.directory }, signal }

  if (target.kind === "file") {
    save(
      await fetchChunks(
        (offset, attempt) => rpc.read({ path: target.path, offset }, { ...options, signal: attempt }),
        name,
        report,
        signal,
      ),
      name,
    )

    return
  }

  // Progress arrives as events; the ones before `archive` answers are kept so none is missed.
  const seen = new Map<string, Files.Archive>()
  const waiters = new Set<() => void>()
  const fresh = { value: false }
  rpc.events.on(
    "archive",
    (event) => {
      if (event.location?.directory !== session.directory) return
      seen.set(event.data.id, event.data)
      fresh.value = true
      waiters.forEach((wake) => wake())
    },
    { signal },
  )

  const started = await rpc.archive({ path: target.kind === "folder" ? target.path : undefined }, options)
  job.release = () => void rpc.release({ id: started.id }, { location: options.location }).catch(() => undefined)
  const archive = { current: seen.get(started.id) ?? started }

  while (archive.current.state === "scanning" || archive.current.state === "zipping") {
    report(progress(name, archive.current))
    // Events normally wake this; the timer covers a dropped event stream by checking whether the zip is ready.
    await new Promise<void>((resolve) => {
      const wake = () => {
        clearTimeout(timer)
        waiters.delete(wake)
        signal.removeEventListener("abort", wake)
        resolve()
      }

      const timer = setTimeout(wake, 2000)
      waiters.add(wake)
      signal.addEventListener("abort", wake, { once: true })

      if (fresh.value || signal.aborted) wake()
    })
    signal.throwIfAborted()
    const next = fresh.value ? seen.get(started.id) : undefined
    fresh.value = false

    if (next) archive.current = next
    else if (
      await rpc.read({ id: started.id, offset: 0 }, options).then(
        () => true,
        () => false,
      )
    )
      archive.current = { ...archive.current, state: "ready" }
  }

  if (archive.current.state === "failed") throw new Error(archive.current.error ?? "The zip couldn't be made")

  if (archive.current.state === "cancelled") throw new Error("The zip was cancelled")
  save(
    await fetchChunks(
      (offset, attempt) => rpc.read({ id: started.id, offset }, { ...options, signal: attempt }),
      name,
      report,
      signal,
    ),
    name,
  )
}

function progress(name: string, archive: Files.Archive): DownloadState {
  if (archive.state === "scanning") return { name, phase: "scanning" }

  return {
    name,
    phase: "zipping",
    progress:
      archive.totalBytes > 0
        ? archive.bytes / archive.totalBytes
        : archive.total > 0
          ? archive.files / archive.total
          : 1,
    files: archive.files,
    total: archive.total,
  }
}

// A piece that stops arriving is given up after this long and fetched again; 4 MB in two minutes is a slow line.
const CHUNK_TIMEOUT_MS = 120_000

// Each piece is read again after a dropped connection (a network change, a proxy timeout, a VM that blinked) before
// the download fails: one lost request shouldn't throw away a zip that is ready.
const CHUNK_RETRIES = 4

export async function fetchChunks(
  read: (offset: number, signal: AbortSignal) => Promise<{ readonly data: string; readonly size: number }>,
  name: string,
  report: (state: DownloadState) => void,
  signal: AbortSignal,
) {
  const parts: Uint8Array<ArrayBuffer>[] = []
  const position = { received: 0, size: Number.POSITIVE_INFINITY }

  // Reading at an offset is idempotent, so a retried piece never duplicates bytes.
  const piece = (offset: number, attempt = 0): ReturnType<typeof read> =>
    read(offset, AbortSignal.any([signal, AbortSignal.timeout(CHUNK_TIMEOUT_MS)])).catch(async (error) => {
      if (signal.aborted || attempt >= CHUNK_RETRIES || !(error instanceof Error) || !droppedConnection(error))
        throw error
      await pause(1000 * 2 ** attempt, signal)

      return piece(offset, attempt + 1)
    })

  while (position.received < position.size) {
    signal.throwIfAborted()
    const chunk = await piece(position.received)
    const bytes = new Uint8Array(base64ToBytes(chunk.data))
    position.size = chunk.size

    if (bytes.byteLength === 0 && position.received < chunk.size) throw new Error("The download stopped early")
    parts.push(bytes)
    position.received += bytes.byteLength
    report({ name, phase: "downloading", progress: chunk.size > 0 ? position.received / chunk.size : 1 })
  }

  return new Blob(parts, { type: name.endsWith(".zip") ? "application/zip" : "application/octet-stream" })
}

// The request never got an answer, rather than the server answering with an error worth showing as it is.
function droppedConnection(error: Error) {
  if (error.name === "TimeoutError" || error.name === "AbortError") return true

  return error.name === "ClientError" && "reason" in error && error.reason === "Transport"
}

function pause(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms)

    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer)
        reject(signal.reason)
      },
      { once: true },
    )
  })
}

function save(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement("a")
  link.href = url
  link.download = name
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

/** How a call rejects: an Error, or the server's RPC error with the file failure as its data. */
export type Failure = { readonly message?: string; readonly data?: { readonly message?: string } }

export function describe(error: Failure) {
  return error.data?.message ?? error.message ?? ""
}
