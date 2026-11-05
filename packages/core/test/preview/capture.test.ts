import { afterEach, describe, expect, test } from "bun:test"
import { createServer, type Server } from "node:http"
import { findChrome } from "@opencode/core/audit/chrome"
import { capturePage } from "@opencode/core/preview/capture"

const chrome = findChrome()
const servers: Server[] = []

afterEach(() => {
  servers.splice(0).forEach((server) => server.close())
})

async function site(html: string) {
  const server = createServer((_, res) => {
    res.setHeader("content-type", "text/html")
    res.end(html)
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()

  return `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/`
}

// The size a VP8/VP8L/VP8X WebP declares, read from its header.
function webpSize(data: Uint8Array) {
  const view = Buffer.from(data)
  const chunk = view.toString("ascii", 12, 16)

  if (chunk === "VP8X") return { width: 1 + view.readUIntLE(24, 3), height: 1 + view.readUIntLE(27, 3) }

  if (chunk === "VP8L") {
    const bits = view.readUInt32LE(21)

    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }
  }

  return { width: view.readUInt16LE(26) & 0x3fff, height: view.readUInt16LE(28) & 0x3fff }
}

describe.skipIf(!chrome)("capturePage", () => {
  test("screenshots a page as a half-size WebP of a desktop window", async () => {
    const url = await site(`<body style="margin:0;background:#0a3a78"><h1 style="color:#fff">Hello</h1></body>`)
    const image = await capturePage({ chrome: chrome!, url })

    expect(Buffer.from(image).toString("ascii", 0, 4)).toBe("RIFF")
    expect(Buffer.from(image).toString("ascii", 8, 12)).toBe("WEBP")
    expect(webpSize(image)).toEqual({ width: 640, height: 400 })
  }, 60_000)

  test("rejects when the page can't be reached", async () => {
    await expect(capturePage({ chrome: chrome!, url: "http://127.0.0.1:9/" })).rejects.toThrow()
  }, 60_000)
})
