import { createWriteStream } from "node:fs"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { pipeline } from "node:stream/promises"
import yauzl from "yauzl"

export class UnzipError extends Error {}

type Planned = { entry: yauzl.Entry; name: string; directory: boolean; mode: number }

/**
 * Unpacks an uploaded zip into `directory`. The whole central directory is checked first, so a zip with any
 * absolute, escaping or symlink entry, or one larger than `maxBytes` unpacked, writes nothing at all. One shared
 * top-level folder (as GitHub's "Download ZIP" makes) is stripped, and macOS `__MACOSX` metadata is skipped.
 */
export async function unzip(input: { zip: string; directory: string; maxBytes: number }) {
  const zip = await openZip(input.zip)
  try {
    const entries = await readEntries(zip)
    const planned = plan(entries, input.maxBytes)
    const root = path.resolve(input.directory)
    for (const item of planned) {
      const target = path.resolve(root, item.name)
      if (target !== root && !target.startsWith(root + path.sep)) throw new UnzipError(`Unsafe path: ${item.name}`)
      if (item.directory) {
        await mkdir(target, { recursive: true })
        continue
      }
      await mkdir(path.dirname(target), { recursive: true })
      const stream = await new Promise<NodeJS.ReadableStream>((resolve, reject) =>
        zip.openReadStream(item.entry, (error, read) => (error ? reject(error) : resolve(read))),
      )
      await pipeline(stream, createWriteStream(target, { mode: item.mode }))
    }
    return { files: planned.filter((item) => !item.directory).length }
  } finally {
    zip.close()
  }
}

function plan(entries: yauzl.Entry[], maxBytes: number): Planned[] {
  const total = entries.reduce((sum, entry) => sum + entry.uncompressedSize, 0)
  if (total > maxBytes) throw new UnzipError(`The zip unpacks to more than ${maxBytes} bytes`)
  const named = entries.flatMap((entry) => {
    const raw = Buffer.isBuffer(entry.fileName) ? entry.fileName.toString("utf8") : entry.fileName
    const name = raw.replaceAll("\\", "/")
    if (name.startsWith("/") || /^[a-zA-Z]:/.test(name)) throw new UnzipError(`Absolute path in zip: ${raw}`)
    const normalized = path.posix.normalize(name)
    if (normalized === ".." || normalized.startsWith("../")) throw new UnzipError(`Path escapes the project: ${raw}`)
    const unixMode = (entry.externalFileAttributes >>> 16) & 0o170000
    if (unixMode === 0o120000) throw new UnzipError(`Symbolic links are not allowed: ${raw}`)
    if (normalized === "__MACOSX" || normalized.startsWith("__MACOSX/")) return []
    const directory = name.endsWith("/") || unixMode === 0o040000
    const clean = normalized.replace(/\/+$/, "")
    if (clean === "" || clean === ".") return []
    const permissions = (entry.externalFileAttributes >>> 16) & 0o777
    return [{ entry, name: clean, directory, mode: permissions & 0o111 ? 0o755 : 0o644 }]
  })
  const tops = new Set(named.map((item) => item.name.split("/")[0]))
  const top = tops.size === 1 ? [...tops][0] : undefined
  const strip =
    top !== undefined &&
    named.every((item) => item.name !== top || item.directory) &&
    named.some((item) => item.name.startsWith(`${top}/`))
  if (!strip) return named
  return named.flatMap((item) => (item.name === top ? [] : [{ ...item, name: item.name.slice(top.length + 1) }]))
}

function openZip(file: string) {
  return new Promise<yauzl.ZipFile>((resolve, reject) =>
    yauzl.open(
      file,
      { lazyEntries: true, autoClose: false, decodeStrings: false, validateEntrySizes: true },
      (error, zip) => (error ? reject(new UnzipError(`Not a valid zip file: ${error.message}`)) : resolve(zip)),
    ),
  )
}

function readEntries(zip: yauzl.ZipFile) {
  return new Promise<yauzl.Entry[]>((resolve, reject) => {
    const entries: yauzl.Entry[] = []
    zip.on("entry", (entry: yauzl.Entry) => {
      entries.push(entry)
      zip.readEntry()
    })
    zip.on("end", () => resolve(entries))
    zip.on("error", (error: Error) => reject(new UnzipError(`Not a valid zip file: ${error.message}`)))
    zip.readEntry()
  })
}
