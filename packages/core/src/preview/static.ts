// A plain file server for sites without a dev server. It listens on a loopback port of its own, so the preview proxy
// forwards to it exactly as it does to a dev server.

import { createReadStream, watch, type FSWatcher } from "node:fs"
import { realpath, stat } from "node:fs/promises"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import path from "node:path"
import { emptyPage } from "./starting-page.js"

/** Content types by file extension, for files served straight from disk. */
export const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".pdf": "application/pdf",
  ".wasm": "application/wasm",
}

export interface StaticSite {
  readonly port: number
  /** Called after files under the root change, at most once per burst of changes. */
  onChange(listener: () => void): () => void
  close(): Promise<void>
}

export async function staticSite(root: string): Promise<StaticSite> {
  const base = await realpath(root)
  const listeners = new Set<() => void>()
  const server = createServer((req, res) => void serve(base, req, res))
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()))
  const address = server.address()
  // Editors save in several writes; one reload per burst is enough.
  const timer: { current?: ReturnType<typeof setTimeout> } = {}
  const watcher: FSWatcher | undefined = (() => {
    try {
      return watch(base, { recursive: true }, () => {
        clearTimeout(timer.current)
        timer.current = setTimeout(() => listeners.forEach((listener) => listener()), 50)
      })
    } catch {
      return undefined
    }
  })()

  return {
    port: typeof address === "object" && address ? address.port : 0,
    onChange: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    close: () =>
      new Promise((resolve) => {
        clearTimeout(timer.current)
        watcher?.close()
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}

async function serve(base: string, req: IncomingMessage, res: ServerResponse) {
  const file = await resolve(base, new URL(req.url ?? "/", "http://site").pathname)

  if (!file) {
    // A page that isn't there shows the empty preview; other files get a plain 404.
    const page = String(req.headers.accept ?? "").includes("text/html")
    res.writeHead(404, { "content-type": page ? "text/html; charset=utf-8" : "text/plain; charset=utf-8" })
    res.end(page ? emptyPage : "")
    return
  }
  res.writeHead(200, {
    "content-type": TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream",
    "cache-control": "no-cache",
  })

  if (req.method === "HEAD") return res.end()
  createReadStream(file).pipe(res)
}

// The file a URL path names: the path itself, `<path>.html`, or `<path>/index.html`. Anything that resolves outside
// the root, through `..` or a symlink, is not found.
async function resolve(base: string, pathname: string) {
  const relative = decodeURIComponent(pathname).replace(/^\/+/, "")
  const target = path.resolve(base, relative)

  if (!inside(base, target)) return undefined

  for (const candidate of [target, `${target}.html`, path.join(target, "index.html")]) {
    const real = await realpath(candidate).catch(() => undefined)

    if (!real || !inside(base, real)) continue
    const info = await stat(real).catch(() => undefined)

    if (info?.isFile()) return real
  }

  return undefined
}

const inside = (base: string, target: string) => target === base || target.startsWith(base + path.sep)
