import { describe, expect, test } from "bun:test"
import { appendLog, enterURL, leftFrom, locationFrom, pagesFrom, previewHealth, previewOrigin } from "./model"

describe("previewOrigin", () => {
  test("uses the server's host with the preview port", () => {
    expect(previewOrigin("http://192.168.1.5:4096", { port: 51234 })).toBe("http://192.168.1.5:51234")
  })

  test("a hosted origin overrides host and port", () => {
    expect(previewOrigin("http://localhost:4096", { port: 1, origin: "https://p1.preview.example.com" })).toBe(
      "https://p1.preview.example.com",
    )
  })

  test("nothing without a port", () => {
    expect(previewOrigin("http://localhost:4096", {})).toBeUndefined()
  })
})

describe("enterURL", () => {
  test("carries the app origin, the page and the ticket", () => {
    const url = new URL(
      enterURL("http://127.0.0.1:5000", { parent: "http://localhost:3000", to: "/about", ticket: "t1" }),
    )

    expect(url.pathname).toBe("/__omai/enter")
    expect(url.searchParams.get("parent")).toBe("http://localhost:3000")
    expect(url.searchParams.get("to")).toBe("/about")
    expect(url.searchParams.get("ticket")).toBe("t1")
  })

  test("leaves the ticket out when there is none", () => {
    expect(new URL(enterURL("http://127.0.0.1:5000", { parent: "http://a", to: "/" })).searchParams.has("ticket")).toBe(
      false,
    )
  })
})

describe("appendLog", () => {
  test("keeps the last 256 KB", () => {
    const log = appendLog("a".repeat(200 * 1024), "b".repeat(100 * 1024))

    expect(log.length).toBe(256 * 1024)
    expect(log.endsWith("b")).toBe(true)
  })
})

describe("locationFrom", () => {
  const origin = "http://127.0.0.1:5000"

  test("reads a location message from the preview", () => {
    expect(
      locationFrom({ origin, data: { type: "omai:location", href: `${origin}/about?x=1`, title: "About" } }, origin),
    ).toEqual({ path: "/about?x=1", title: "About" })
  })

  test("ignores another origin", () => {
    expect(
      locationFrom({ origin: "https://evil.example", data: { type: "omai:location", href: "x", title: "" } }, origin),
    ).toBeUndefined()
  })

  test("ignores other messages", () => {
    expect(
      locationFrom({ origin, data: { type: "omai:console", level: "error", message: "x" } }, origin),
    ).toBeUndefined()
  })
})

describe("pagesFrom", () => {
  const origin = "http://127.0.0.1:5000"

  test("reads the pages a preview reports", () => {
    expect(pagesFrom({ origin, data: { type: "omai:pages", pages: ["/", "/about"] } }, origin)).toEqual(["/", "/about"])
  })

  test("ignores another origin and malformed lists", () => {
    expect(
      pagesFrom({ origin: "https://evil.example", data: { type: "omai:pages", pages: ["/"] } }, origin),
    ).toBeUndefined()
    expect(pagesFrom({ origin, data: { type: "omai:pages", pages: [1] } }, origin)).toBeUndefined()
  })
})

describe("previewHealth", () => {
  const origin = "https://preview--vm.code.run"
  const answer = (body: string, init: ResponseInit = {}) => async () => new Response(body, init)
  const health = (up: boolean) => answer(JSON.stringify({ preview: "omai", up }))

  test("reads the preview's own answer", async () => {
    expect(await previewHealth(origin, health(true))).toEqual({ up: true })
    expect(await previewHealth(origin, health(false))).toEqual({ up: false })
  })

  test("asks the health address, uncached", async () => {
    const asked: Array<{ url: string; cache?: RequestCache }> = []
    await previewHealth(origin, async (url, init) => {
      asked.push({ url: String(url), cache: init?.cache })

      return new Response(JSON.stringify({ preview: "omai", up: true }))
    })
    expect(asked).toEqual([{ url: `${origin}/__omai/health`, cache: "no-store" }])
  })

  // What answers while a VM boots or pauses: a load balancer's error page, or nothing at all.
  test("anything else is unreachable", async () => {
    expect(await previewHealth(origin, answer("upstream connect error", { status: 503 }))).toBeUndefined()
    expect(await previewHealth(origin, async () => new Response("<html>"))).toBeUndefined()
    expect(await previewHealth(origin, answer(JSON.stringify({ up: true })))).toBeUndefined()
    expect(
      await previewHealth(origin, async () => {
        throw new TypeError("Failed to fetch")
      }),
    ).toBeUndefined()
  })
})

describe("leftFrom", () => {
  const origin = "http://127.0.0.1:5000"

  test("reads a page leaving, from the preview only", () => {
    expect(leftFrom({ origin, data: { type: "omai:leave" } }, origin)).toBe(true)
    expect(leftFrom({ origin: "https://evil.example", data: { type: "omai:leave" } }, origin)).toBe(false)
    expect(leftFrom({ origin, data: { type: "omai:location" } }, origin)).toBe(false)
  })
})
