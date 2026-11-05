import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises"
import { request } from "node:http"
import { tmpdir } from "node:os"
import path from "node:path"
import { staticSite } from "@opencode/core/preview/static"

const sites: Array<{ close(): Promise<void> }> = []

afterEach(async () => {
  await Promise.all(sites.splice(0).map((site) => site.close()))
})

async function site(files: Record<string, string>) {
  const root = await mkdtemp(path.join(tmpdir(), "omai-static-"))
  await Promise.all(
    Object.entries(files).map(async ([file, body]) => {
      await mkdir(path.dirname(path.join(root, file)), { recursive: true })
      await writeFile(path.join(root, file), body)
    }),
  )
  const opened = await staticSite(root)
  sites.push(opened)
  return { root, ...opened }
}

function get(port: number, url: string, accept?: string) {
  return new Promise<{ status: number; type: string; body: string }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path: url, headers: accept ? { accept } : {} }, (res) => {
      const chunks: Buffer[] = []
      res.on("data", (chunk: Buffer) => chunks.push(chunk))
      res.on("end", () =>
        resolve({
          status: res.statusCode ?? 0,
          type: String(res.headers["content-type"] ?? ""),
          body: Buffer.concat(chunks).toString(),
        }),
      )
    })
    req.on("error", reject)
    req.end()
  })
}

describe("staticSite", () => {
  test("serves index.html at /", async () => {
    const opened = await site({ "index.html": "<h1>home</h1>" })

    expect(await get(opened.port, "/")).toMatchObject({ status: 200, body: "<h1>home</h1>" })
  })

  test("clean urls", async () => {
    const opened = await site({ "about.html": "about" })

    expect((await get(opened.port, "/about")).body).toBe("about")
  })

  test("directory index", async () => {
    const opened = await site({ "blog/index.html": "blog" })

    expect((await get(opened.port, "/blog/")).body).toBe("blog")
  })

  test("content types", async () => {
    const opened = await site({ "a.css": "", "a.js": "", "a.svg": "" })

    expect((await get(opened.port, "/a.css")).type).toContain("text/css")
    expect((await get(opened.port, "/a.js")).type).toContain("text/javascript")
    expect((await get(opened.port, "/a.svg")).type).toContain("image/svg+xml")
  })

  test("404 for missing files, with no fallback page", async () => {
    const opened = await site({ "index.html": "home" })

    expect((await get(opened.port, "/missing")).status).toBe(404)
  })

  test("a missing page shows only the logo, without text", async () => {
    const opened = await site({ "style.css": "" })
    const page = await get(opened.port, "/", "text/html")

    expect(page.status).toBe(404)
    expect(page.type).toContain("text/html")
    expect(page.body).toContain('src="/__omai/logo"')
    expect(page.body).not.toContain("Not found")
  })

  test("never serves files outside the root", async () => {
    const outside = await mkdtemp(path.join(tmpdir(), "omai-secret-"))
    await writeFile(path.join(outside, "secret.txt"), "secret")
    const opened = await site({ "index.html": "home" })
    await symlink(path.join(outside, "secret.txt"), path.join(opened.root, "link.txt"))

    expect((await get(opened.port, "/../secret.txt")).status).toBe(404)
    expect((await get(opened.port, "/link.txt")).status).toBe(404)
  })

  test("reports file changes", async () => {
    const opened = await site({ "index.html": "home" })
    const changed = new Promise<void>((resolve) => opened.onChange(resolve))
    await Bun.sleep(50)
    await writeFile(path.join(opened.root, "index.html"), "home 2")
    const result = await Promise.race([changed.then(() => "changed"), Bun.sleep(1_000).then(() => "timeout")])

    expect(result).toBe("changed")
  })
})
