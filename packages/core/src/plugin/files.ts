export * as FilesPlugin from "./files.js"

import { randomUUID } from "node:crypto"
import { lstat, mkdir, mkdtemp, open, realpath, rename, rm, stat } from "node:fs/promises"
import path from "node:path"
import { define } from "@opencode/plugin/effect/plugin"
import { Files } from "@opencode/schema/files"
import { Global } from "@opencode/util/global"
import { Effect } from "effect"
import { Zip } from "../files/zip.js"

/** Bytes per `read` call; base64 makes each response about a third larger. */
export const CHUNK = 4 * 1024 * 1024
/** How long a finished archive waits to be downloaded. */
const TTL = 10 * 60 * 1000

type Context<E> = {
  readonly error: (name: "files.failed", message: string, data: { kind: Files.FailureKind; message: string }) => E
}

class Failure extends Error {
  constructor(
    readonly kind: Files.FailureKind,
    message: string,
  ) {
    super(message)
  }
}

type Job = { status: Files.Archive; file: string; abort: AbortController; expiry?: ReturnType<typeof setTimeout> }

export const Plugin = define({
  id: "omai.files",
  effect: Effect.fn(function* (ctx) {
    const global = yield* Global.Service
    const root = ctx.location.directory
    const jobs = new Map<string, Job>()
    const holder: { emit?: (status: Files.Archive) => void } = {}
    const folder = { path: undefined as string | undefined }

    const temp = async () => {
      if (folder.path) return folder.path
      await mkdir(global.tmp, { recursive: true })
      folder.path = await mkdtemp(path.join(global.tmp, "omai-archive-"))
      return folder.path
    }

    const release = (id: string) => {
      const job = jobs.get(id)
      if (!job) return
      jobs.delete(id)
      clearTimeout(job.expiry)
      job.abort.abort()
      void rm(job.file, { force: true })
    }

    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        ;[...jobs.keys()].forEach(release)
        if (folder.path) await rm(folder.path, { recursive: true, force: true })
      }),
    )

    const start = async (input: { path?: string }) => {
      const relative = input.path ? normalize(input.path) : ""
      const running = [...jobs.values()].find(
        (job) => job.status.path === relative && (job.status.state === "scanning" || job.status.state === "zipping"),
      )
      if (running) return running.status
      const directory = relative ? await confined(root, relative) : root
      const info = await stat(directory).catch(() => undefined)
      if (!info?.isDirectory()) throw new Failure("not-found", `Folder not found: ${relative}`)
      const base = path.basename(directory) || "project"
      const id = randomUUID()
      const job: Job = {
        status: { id, path: relative, name: `${base}.zip`, state: "scanning", files: 0, total: 0, bytes: 0, totalBytes: 0 },
        file: path.join(await temp(), `${id}.zip`),
        abort: new AbortController(),
      }
      jobs.set(id, job)
      void build(job, directory, base)
      return job.status
    }

    const lastSent = new Map<string, number>()
    const update = (job: Job, next: Partial<Files.Archive>, force = false) => {
      job.status = { ...job.status, ...next }
      const now = Date.now()
      // Progress is throttled; state changes always go out.
      if (!force && now - (lastSent.get(job.status.id) ?? 0) < 150) return
      lastSent.set(job.status.id, now)
      holder.emit?.(job.status)
    }

    const build = async (job: Job, directory: string, base: string) => {
      const signal = job.abort.signal
      try {
        const scanned = await Zip.scan(directory, base, signal)
        update(job, { state: "zipping", total: scanned.entries.filter((entry) => entry.type === "file").length, totalBytes: scanned.bytes }, true)
        const size = await Zip.write(scanned.entries, job.file, (progress) => update(job, progress), signal)
        update(job, { state: "ready", size }, true)
        job.expiry = setTimeout(() => release(job.status.id), TTL)
      } catch (error) {
        const cancelled = signal.aborted
        update(job, { state: cancelled ? "cancelled" : "failed", error: cancelled ? undefined : message(error) }, true)
        await rm(job.file, { force: true })
        if (jobs.get(job.status.id) === job) job.expiry = setTimeout(() => jobs.delete(job.status.id), TTL)
      } finally {
        lastSent.delete(job.status.id)
      }
    }

    const read = async (input: { id?: string; path?: string; offset: number }) => {
      const file = input.id ? readyArchive(input.id) : input.path ? await confined(root, normalize(input.path), { existing: true, follow: true }) : undefined
      if (!file) throw new Failure("invalid", "Nothing to read")
      const handle = await open(file, "r").catch(() => {
        throw new Failure("not-found", "File not found")
      })
      try {
        const info = await handle.stat()
        if (!info.isFile()) throw new Failure("not-found", "File not found")
        const length = Math.max(0, Math.min(CHUNK, info.size - input.offset))
        const buffer = Buffer.alloc(length)
        const read = length > 0 ? await handle.read(buffer, 0, length, input.offset) : { bytesRead: 0 }
        return { data: buffer.subarray(0, read.bytesRead).toString("base64"), size: info.size }
      } finally {
        await handle.close()
      }
    }

    const readyArchive = (id: string) => {
      const job = jobs.get(id)
      if (job?.status.state !== "ready") throw new Failure("not-found", "This download expired. Start it again.")
      return job.file
    }

    const rpc = yield* ctx.rpc
      .register(Files.Definition, {
        rename: (input, context) =>
          attempt(context, async () => {
            const from = await confined(root, normalize(input.from), { existing: true })
            const to = await confined(root, normalize(input.to))
            if (await lstat(to).then(() => true, () => false)) throw new Failure("exists", `${path.basename(to)} already exists`)
            await mkdir(path.dirname(to), { recursive: true })
            await rename(from, to)
            return {}
          }),
        remove: (input, context) =>
          attempt(context, async () => {
            await rm(await confined(root, normalize(input.path), { existing: true }), { recursive: true })
            return {}
          }),
        archive: (input, context) => attempt(context, () => start(input)),
        read: (input, context) => attempt(context, () => read(input)),
        release: (input) =>
          Effect.sync(() => {
            release(input.id)
            return {}
          }),
      })
      .pipe(Effect.orDie)

    holder.emit = (status) => Effect.runFork(rpc.events.emit("archive", status).pipe(Effect.ignore))
  }),
})

function attempt<A, E>(context: Context<E>, run: () => Promise<A>) {
  return Effect.tryPromise({
    try: run,
    catch: (error) =>
      error instanceof Failure
        ? context.error("files.failed", error.message, { kind: error.kind, message: error.message })
        : context.error("files.failed", message(error), { kind: "other", message: message(error) }),
  })
}

function message(error: unknown) {
  if (error instanceof Zip.LimitError) return `The project is too large to download: ${error.message.toLowerCase()}`
  if (error instanceof Error) return error.message
  return String(error)
}

/** A project-relative path with `/` separators and no leading or trailing slash. */
export function normalize(value: string) {
  return value
    .replaceAll("\\", "/")
    .replace(/^\/+|\/+$/g, "")
    .replace(/\/{2,}/g, "/")
}

/**
 * Resolves a project-relative path, failing when it leaves the project, names the project itself, sits in `.git`, or
 * passes through a symlink that leaves the project. With `existing`, the path must exist; with `follow`, the path
 * itself must also resolve inside the project, for reads that follow a symlink.
 */
export async function confined(root: string, relative: string, options?: { existing?: boolean; follow?: boolean }) {
  if (!relative || relative.includes("\0")) throw new Failure("invalid", "Choose a file or folder in the project")
  const parts = relative.split("/")
  if (parts.some((part) => part === ".." || part === ".")) throw new Failure("invalid", "Paths can't leave the project")
  if (parts[0] === ".git") throw new Failure("invalid", "Git's own files can't be changed here")
  const absolute = path.join(root, ...parts)
  const real = await realpath(root)
  // The nearest existing ancestor must resolve inside the project; the entry itself may be a symlink, which is renamed
  // or removed as is.
  if (!contains(real, await nearest(path.dirname(absolute)))) throw new Failure("invalid", "Paths can't leave the project")
  if (options?.existing && !(await lstat(absolute).then(() => true, () => false)))
    throw new Failure("not-found", `${relative} doesn't exist`)
  if (options?.follow && !contains(real, await realpath(absolute))) throw new Failure("invalid", "Paths can't leave the project")
  return absolute
}

async function nearest(directory: string): Promise<string> {
  const real = await realpath(directory).catch(() => undefined)
  if (real !== undefined) return real
  const parent = path.dirname(directory)
  return parent === directory ? directory : nearest(parent)
}

function contains(parent: string, child: string) {
  const relative = path.relative(parent, child)
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
}
