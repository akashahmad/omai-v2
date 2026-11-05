import { describe, expect, test } from "bun:test"
import type { Publish } from "@opencode/schema/publish"
import { duration, fixPrompt, liveAddress, slug, stepState, STEPS } from "./model"

const deploy = (input: Partial<Publish.Deploy> = {}): Publish.Deploy => ({
  id: "dep_1",
  status: "running",
  startedAt: 0,
  stages: [],
  ...input,
})

const site: Publish.Site = { name: "shop", url: "https://shop.omai.ch", zone: "omai.ch" }

const domain = (hostname: string, status: Publish.DomainStatus, primary = true): Publish.Domain => ({
  hostname,
  primary,
  status,
  ssl: status,
  apex: false,
  records: [],
})

describe("stepState", () => {
  test("stepState marks the failed stage and later stages todo", () => {
    const failed = deploy({
      status: "failed",
      stage: "build",
      stages: [
        { stage: "prepare", startedAt: 0, finishedAt: 1 },
        { stage: "install", startedAt: 1, finishedAt: 2 },
        { stage: "build", startedAt: 2, finishedAt: 3 },
      ],
    })

    expect(STEPS.map((step) => stepState(failed, step))).toEqual(["done", "done", "failed", "todo", "todo"])
  })

  test("marks the running stage active", () => {
    const running = deploy({ stage: "install", stages: [{ stage: "prepare", startedAt: 0, finishedAt: 1 }] })

    expect(STEPS.map((step) => stepState(running, step))).toEqual(["done", "active", "todo", "todo", "todo"])
  })

  test("a run that has not reported a stage yet is preparing", () => {
    expect(stepState(deploy(), "prepare")).toBe("active")
    expect(stepState(deploy(), "install")).toBe("todo")
  })

  test("a live deploy is done at every step, skipped ones included", () => {
    const live = deploy({ status: "live", stage: "upload" })

    expect(STEPS.map((step) => stepState(live, step))).toEqual(["done", "done", "done", "done", "done"])
  })

  test("a cancelled run leaves where it stopped and later steps todo", () => {
    const cancelled = deploy({ status: "cancelled", stage: "upload" })

    expect(STEPS.map((step) => stepState(cancelled, step))).toEqual(["done", "done", "done", "todo", "todo"])
  })
})

describe("liveAddress", () => {
  test("liveAddress prefers an active primary", () => {
    const withPrimary = { ...site, primary: "www.shop.ch" }

    expect(liveAddress(withPrimary, [domain("www.shop.ch", "active")])).toBe("https://www.shop.ch")
  })

  test("falls back to the subdomain while the primary is not active", () => {
    const withPrimary = { ...site, primary: "www.shop.ch" }

    expect(liveAddress(withPrimary, [domain("www.shop.ch", "pending")])).toBe("https://shop.omai.ch")
    expect(liveAddress(withPrimary, [])).toBe("https://shop.omai.ch")
    expect(liveAddress(site, [domain("other.ch", "active", false)])).toBe("https://shop.omai.ch")
  })
})

describe("duration", () => {
  test("reads minutes and seconds, and hours when it takes that long", () => {
    expect(duration(deploy({ startedAt: 1_000, finishedAt: 46_000 }))).toBe("0:45")
    expect(duration(deploy({ startedAt: 0, finishedAt: 83_000 }))).toBe("1:23")
    expect(duration(deploy({ startedAt: 0, finishedAt: 3_723_000 }))).toBe("1:02:03")
  })

  test("a running deploy counts up to now", () => {
    expect(duration(deploy({ startedAt: 0 }), 5_000)).toBe("0:05")
  })
})

describe("slug", () => {
  test("turns a project name into a site name", () => {
    expect(slug("My Shop!")).toBe("my-shop")
    expect(slug("---")).toBe("site")
    expect(slug("a".repeat(60))).toHaveLength(40)
  })
})

describe("fixPrompt", () => {
  test("hands the reason and the last 4096 characters of the log to the agent", () => {
    const log = `${"x".repeat(5000)}END`
    const text = fixPrompt(deploy({ status: "failed", stage: "build", error: "Build failed" }), log)

    expect(text).toContain("Build failed")
    expect(text).toContain("build")
    expect(text).toContain(log.slice(-4096))
    expect(text).not.toContain(log.slice(-4097))
  })
})
