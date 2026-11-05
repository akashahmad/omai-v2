export * as Zip from "./zip.js"

import { constants } from "node:fs"
import { lstat, open, readdir, readlink, type FileHandle } from "node:fs/promises"
import path from "node:path"
import { Transform, Writable } from "node:stream"
import { pipeline } from "node:stream/promises"
import zlib from "node:zlib"

// Plain zip without zip64: every size and offset fits in 32 bits under these limits.
export const limits = {
  entries: 65_000,
  bytes: 2 * 1024 * 1024 * 1024,
} as const

export class LimitError extends Error {}

export type Entry = {
  /** Path inside the zip, with `/` separators and no trailing slash. */
  name: string
  absolute: string
  type: "file" | "directory" | "link"
  size: number
  mode: number
  mtime: Date
}

export type Progress = { files: number; bytes: number }

const vcs = new Set([".git", ".hg", ".svn"])
const skipped = new Set([
  // Dependencies and package manager caches.
  "node_modules",
  "bower_components",
  ".pnpm-store",
  ".npm",
  ".yarn-cache",
  // Tool and framework build caches; a fresh install and build recreates them.
  ".cache",
  ".turbo",
  ".parcel-cache",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".output",
  ".vercel",
  ".netlify",
  ".wrangler",
  ".astro",
  ".angular",
  ".expo",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".gradle",
  ".venv",
  // Credentials.
  ".ssh",
  ".aws",
  ".gnupg",
  ".secrets",
])
const secrets = new Set([
  ".netrc",
  ".git-credentials",
  ".npmrc",
  "auth.json",
  "mcp-auth.json",
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  ".DS_Store",
])
// Already compressed formats are stored: deflating them again costs time and saves nothing.
const stored = new Set(
  "png jpg jpeg gif webp avif heic mp4 m4v mov webm mkv mp3 m4a aac ogg opus flac zip gz tgz bz2 xz 7z rar zst br woff woff2 pdf jar apk"
    .split(" ")
    .map((ext) => `.${ext}`),
)
// Files up to this size are read and compressed in one call; larger ones stream.
const whole = 4 * 1024 * 1024

/** Whether a project-relative path is left out of downloads. */
export function excluded(relative: string) {
  const parts = relative.split("/")
  if (parts.some((part) => vcs.has(part) || skipped.has(part))) return true
  const base = parts.at(-1) ?? ""
  if (secrets.has(base)) return true
  return /^\.env(?:\.|$)/.test(base) && !/\.(?:example|sample|template)$/.test(base)
}

/** Lists what a zip of `root` holds, under a top folder named `base`. Symlinks that leave `root` are skipped. */
export async function scan(root: string, base: string, signal?: AbortSignal) {
  const entries: Entry[] = []
  const pending = [root]
  let bytes = 0
  while (pending.length > 0) {
    signal?.throwIfAborted()
    const directory = pending.pop()!
    const children = await readdir(directory, { withFileTypes: true })
    children.sort((a, b) => a.name.localeCompare(b.name))
    for (const child of children) {
      const absolute = path.join(directory, child.name)
      const relative = path.relative(root, absolute).split(path.sep).join("/")
      if (excluded(relative)) continue
      const info = await lstat(absolute).catch(() => undefined)
      if (!info) continue
      const type = info.isDirectory() ? "directory" : info.isFile() ? "file" : info.isSymbolicLink() ? "link" : undefined
      if (!type) continue
      if (type === "link" && !inside(relative, await readlink(absolute).catch(() => ""))) continue
      if (type === "directory") pending.push(absolute)
      if (type === "file") bytes += info.size
      entries.push({ name: `${base}/${relative}`, absolute, type, size: type === "file" ? info.size : 0, mode: info.mode, mtime: info.mtime })
      if (entries.length > limits.entries) throw new LimitError(`More than ${limits.entries} files`)
      if (bytes > limits.bytes) throw new LimitError("More than 2 GB of files")
    }
  }
  return { entries: [{ name: base, absolute: root, type: "directory" as const, size: 0, mode: 0o40755, mtime: new Date() }, ...entries], bytes }
}

function inside(name: string, target: string) {
  if (!target || path.posix.isAbsolute(target) || target.includes("\\")) return false
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(name), target))
  return resolved !== ".." && !resolved.startsWith("../")
}

/** Writes `entries` as a zip file at `output`, reporting progress after each file and as large files stream. */
export async function write(entries: readonly Entry[], output: string, onProgress: (progress: Progress) => void, signal?: AbortSignal) {
  const handle = await open(output, "w", 0o600)
  const central: Buffer[] = []
  const progress = { files: 0, bytes: 0 }
  let position = 0
  const put = async (data: Uint8Array) => {
    await handle.write(data, 0, data.byteLength, position)
    position += data.byteLength
  }
  try {
    for (const entry of entries) {
      signal?.throwIfAborted()
      const offset = position
      const record = await (entry.type === "file" && entry.size > whole
        ? streamed(handle, entry, offset, put, (bytes) => {
            progress.bytes += bytes
            onProgress(progress)
          }, signal)
        : buffered(entry, put))
      if (entry.type === "file") {
        progress.files++
        if (entry.size <= whole) progress.bytes += record.size
        onProgress(progress)
      }
      central.push(header("central", entry, record, offset))
    }
    const directory = Buffer.concat(central)
    const end = Buffer.alloc(22)
    end.writeUInt32LE(0x06054b50, 0)
    end.writeUInt16LE(entries.length, 8)
    end.writeUInt16LE(entries.length, 10)
    end.writeUInt32LE(directory.byteLength, 12)
    end.writeUInt32LE(position, 16)
    await put(directory)
    await put(end)
    return position
  } finally {
    await handle.close()
  }
}

type Record = { method: 0 | 8; crc: number; compressed: number; size: number }

async function buffered(entry: Entry, put: (data: Uint8Array) => Promise<void>): Promise<Record> {
  const data =
    entry.type === "file"
      ? await readWhole(entry.absolute)
      : entry.type === "link"
        ? Buffer.from(await readlink(entry.absolute))
        : Buffer.alloc(0)
  const deflated = entry.type === "file" && data.byteLength > 0 && !stored.has(path.extname(entry.name).toLowerCase())
    ? zlib.deflateRawSync(data, { level: 6 })
    : undefined
  const smaller = deflated && deflated.byteLength < data.byteLength ? deflated : undefined
  const record: Record = {
    method: smaller ? 8 : 0,
    crc: data.byteLength > 0 ? zlib.crc32(data) : 0,
    compressed: (smaller ?? data).byteLength,
    size: data.byteLength,
  }
  await put(header("local", entry, record, 0))
  await put(smaller ?? data)
  return record
}

async function readWhole(file: string) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    return await handle.readFile()
  } finally {
    await handle.close()
  }
}

// A large file streams after a placeholder header, which is patched once its CRC and sizes are known. Data descriptors
// would avoid the patch, but some unzip tools reject them on stored entries.
async function streamed(
  handle: FileHandle,
  entry: Entry,
  offset: number,
  put: (data: Uint8Array) => Promise<void>,
  onBytes: (bytes: number) => void,
  signal?: AbortSignal,
): Promise<Record> {
  const method = stored.has(path.extname(entry.name).toLowerCase()) ? 0 : 8
  const record: Record = { method, crc: 0, compressed: 0, size: 0 }
  await put(header("local", entry, record, 0))
  const source = await open(entry.absolute, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const count = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        record.crc = zlib.crc32(chunk, record.crc)
        record.size += chunk.byteLength
        onBytes(chunk.byteLength)
        done(null, chunk)
      },
    })
    const sink = new Writable({
      write(chunk: Buffer, _encoding, done) {
        record.compressed += chunk.byteLength
        put(chunk).then(() => done(), done)
      },
    })
    const stages = method === 8 ? [count, zlib.createDeflateRaw({ level: 6 }), sink] : [count, sink]
    await pipeline([source.createReadStream({ autoClose: false }), ...stages], { signal })
  } finally {
    await source.close()
  }
  const patch = Buffer.alloc(12)
  patch.writeUInt32LE(record.crc >>> 0, 0)
  patch.writeUInt32LE(record.compressed, 4)
  patch.writeUInt32LE(record.size, 8)
  await handle.write(patch, 0, 12, offset + 14)
  return record
}

function header(kind: "local" | "central", entry: Entry, record: Record, offset: number) {
  const name = Buffer.from(entry.type === "directory" ? `${entry.name}/` : entry.name)
  const local = kind === "local"
  const buffer = Buffer.alloc((local ? 30 : 46) + name.byteLength)
  const time = dos(entry.mtime)
  let at = 0
  const u16 = (value: number) => {
    buffer.writeUInt16LE(value, at)
    at += 2
  }
  const u32 = (value: number) => {
    buffer.writeUInt32LE(value >>> 0, at)
    at += 4
  }
  u32(local ? 0x04034b50 : 0x02014b50)
  if (!local) u16(0x0314) // made by Unix, zip 2.0
  u16(20) // version needed
  u16(0x0800) // UTF-8 names
  u16(record.method)
  u16(time.time)
  u16(time.date)
  u32(record.crc)
  u32(record.compressed)
  u32(record.size)
  u16(name.byteLength)
  u16(0) // extra
  if (!local) {
    u16(0) // comment
    u16(0) // disk
    u16(0) // internal attributes
    u32(((unixMode(entry) << 16) | (entry.type === "directory" ? 0x10 : 0)) >>> 0)
    u32(offset)
  }
  name.copy(buffer, at)
  return buffer
}

function unixMode(entry: Entry) {
  if (entry.type === "directory") return 0o40000 | (entry.mode & 0o777 || 0o755)
  if (entry.type === "link") return 0o120777
  return 0o100000 | (entry.mode & 0o777 || 0o644)
}

function dos(date: Date) {
  const year = Math.min(2107, Math.max(1980, date.getFullYear()))
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  }
}
