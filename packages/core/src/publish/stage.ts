export * as PublishStage from "./stage.js"

import { copyFile, lstat, mkdir, readdir, rm, utimes } from "node:fs/promises"
import path from "node:path"

/** Directory names never copied from the source and never deleted from the stage, at any depth. */
export const EXCLUDE: ReadonlySet<string> = new Set([
  "node_modules",
  ".git",
  ".wrangler",
  ".open-next",
  ".svelte-kit",
  ".output",
  ".vercel",
  ".netlify",
  ".next",
  ".astro",
  ".turbo",
  ".cache",
])

/**
 * Uploadable copy of a static site, at the stage root. It is owned by `staticAssets`, so `sync` neither copies a
 * source entry with this name nor deletes it from the stage.
 */
export const STATIC_DIR = ".omai-static"

/** Mirrors `source` into `stage`. Only the stage is written; symlinks are skipped. */
export async function sync(source: string, stage: string) {
  await mkdir(stage, { recursive: true })
  const result = { copied: 0, removed: 0 }
  await mirror(source, stage, true, result)
  return result
}

async function mirror(source: string, stage: string, root: boolean, result: { copied: number; removed: number }) {
  const skip = (name: string) => EXCLUDE.has(name) || (root && name === STATIC_DIR)
  const wanted = (await readdir(source, { withFileTypes: true })).filter(
    (entry) => !entry.isSymbolicLink() && (entry.isDirectory() || entry.isFile()) && !skip(entry.name),
  )
  const names = new Set(wanted.map((entry) => entry.name))

  // Stage entries without a source counterpart are deleted, except the names `skip` protects (node_modules and other
  // EXCLUDE directories are never entered or removed).
  const existing = await readdir(stage, { withFileTypes: true })
  const stale = existing.filter((entry) => !skip(entry.name) && !names.has(entry.name))
  await Promise.all(
    stale.map(async (entry) => {
      result.removed += await count(path.join(stage, entry.name))
      await rm(path.join(stage, entry.name), { recursive: true, force: true })
    }),
  )
  // A source entry replacing a stage entry of another kind (file, directory or symlink) must not leave the old one behind.
  // A symlink never matches, so copying can never write through a link in the stage.
  const kind = (entry: { isDirectory(): boolean; isFile(): boolean }) =>
    entry.isDirectory() ? "dir" : entry.isFile() ? "file" : "other"
  const kinds = new Map(existing.map((entry) => [entry.name, kind(entry)]))
  await Promise.all(
    wanted
      .filter((entry) => kinds.has(entry.name) && kinds.get(entry.name) !== kind(entry))
      .map(async (entry) => {
        result.removed += await count(path.join(stage, entry.name))
        await rm(path.join(stage, entry.name), { recursive: true, force: true })
      }),
  )

  for (const entry of wanted) {
    const from = path.join(source, entry.name)
    const to = path.join(stage, entry.name)
    if (entry.isDirectory()) {
      await mkdir(to, { recursive: true })
      await mirror(from, to, false, result)
      continue
    }
    const info = await lstat(from)
    const current = await lstat(to).catch(() => undefined)
    if (current?.isFile() && current.size === info.size && Math.floor(current.mtimeMs) === Math.floor(info.mtimeMs))
      continue
    // Removing first lets read-only (0444) stage copies be replaced and never writes through a link.
    await rm(to, { force: true })
    await copyFile(from, to)
    // Keeps the stage mtime equal to the source so the next sync sees the file as unchanged.
    await utimes(to, info.atime, info.mtime)
    result.copied++
  }
}

async function count(target: string): Promise<number> {
  const info = await lstat(target)
  if (!info.isDirectory()) return 1
  const children = await readdir(target)
  return (await Promise.all(children.map((child) => count(path.join(target, child))))).reduce((a, b) => a + b, 0)
}

/**
 * Deletes build output paths (relative to the stage) so stale files are never uploaded. Paths outside the stage are
 * ignored, and nothing is deleted through a symlinked parent directory (a symlink named as an output is itself removed).
 */
export async function clean(stage: string, outputs: string[]) {
  const root = path.resolve(stage)
  await Promise.all(
    outputs.map(async (output) => {
      const target = path.resolve(root, output)
      if (!target.startsWith(root + path.sep)) return
      const parents = path.relative(root, path.dirname(target)).split(path.sep).filter(Boolean)
      for (let index = 1; index <= parents.length; index++) {
        const info = await lstat(path.join(root, ...parents.slice(0, index))).catch(() => undefined)
        if (!info?.isDirectory()) return
      }
      await rm(target, { recursive: true, force: true })
    }),
  )
}

/**
 * Whether a path relative to the site root may be uploaded. Secrets (`.env*`) are copied into the stage so builds can
 * read them, but must never be served.
 */
export function uploadable(): (relative: string) => boolean {
  const blocked = (segment: string) => segment.startsWith(".env") || segment === ".DS_Store" || EXCLUDE_UPLOAD.has(segment)
  return (relative) => !relative.split(/[\\/]/).some(blocked)
}

const EXCLUDE_UPLOAD: ReadonlySet<string> = new Set([".git", "node_modules"])

/**
 * Rebuilds `<stage>/.omai-static` from the stage tree (optionally from the `from` subdirectory, e.g. a build output),
 * filtered with `uploadable`, and returns its path. Only the stage is written.
 */
export async function staticAssets(stage: string, from = ".") {
  const out = path.join(stage, STATIC_DIR)
  await rm(out, { recursive: true, force: true })
  await mkdir(out, { recursive: true })
  const allowed = uploadable()
  const base = path.resolve(stage, from)
  if (base !== path.resolve(stage) && !base.startsWith(path.resolve(stage) + path.sep))
    throw new Error(`static root escapes the stage: ${from}`)
  const walk = async (relative: string) => {
    const entries = await readdir(path.join(base, relative), { withFileTypes: true })
    for (const entry of entries) {
      const next = path.join(relative, entry.name)
      if (entry.isSymbolicLink() || !allowed(next) || EXCLUDE.has(entry.name) || next === STATIC_DIR) continue
      if (entry.isDirectory()) {
        await mkdir(path.join(out, next), { recursive: true })
        await walk(next)
        continue
      }
      if (entry.isFile()) await copyFile(path.join(base, next), path.join(out, next))
    }
  }
  await walk("")
  return out
}
