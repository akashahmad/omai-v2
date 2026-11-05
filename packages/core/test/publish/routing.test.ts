import { describe, expect, test } from "bun:test"
import { PublishRouting } from "../../src/publish/routing"

const zone = "omai.ch"
const domain = (hostname: string, primary: boolean, status: string) => ({ hostname, primary, status })

describe("PublishRouting.routes", () => {
  test("alias redirects to an active primary", () => {
    const map = PublishRouting.routes({
      name: "app",
      zone,
      domains: [domain("www.primary.edu", true, "active"), domain("primary.edu", false, "pending")],
    })
    expect(map.get("www.primary.edu")).toEqual({ script: "app" })
    expect(map.get("primary.edu")).toEqual({ redirect: "www.primary.edu" })
  })

  test("alias serves the script while the primary is pending", () => {
    const map = PublishRouting.routes({
      name: "app",
      zone,
      domains: [domain("www.primary.edu", true, "pending"), domain("primary.edu", false, "active")],
    })
    expect(map.get("primary.edu")).toEqual({ script: "app" })
  })

  test("subdomain redirects only when the primary is active", () => {
    const build = (status: string) =>
      PublishRouting.routes({ name: "app", zone, domains: [domain("www.primary.edu", true, status)] })
    expect(build("active").get("app.omai.ch")).toEqual({ redirect: "www.primary.edu" })
    expect(build("pending").has("app.omai.ch")).toBe(false)
  })

  test("without a primary every domain serves the script", () => {
    const map = PublishRouting.routes({ name: "app", zone, domains: [domain("a.edu", false, "active")] })
    expect(map.get("a.edu")).toEqual({ script: "app" })
    expect(map.size).toBe(1)
  })
})

describe("PublishRouting.diff", () => {
  test("diff removes hosts no longer routed and leaves unchanged ones", () => {
    const current = new Map<string, PublishRouting.Route>([
      ["same.edu", { script: "app" }],
      ["gone.edu", { script: "app" }],
      ["changed.edu", { script: "app" }],
    ])
    const next = new Map<string, PublishRouting.Route>([
      ["same.edu", { script: "app" }],
      ["changed.edu", { redirect: "same.edu" }],
      ["new.edu", { script: "app" }],
    ])
    expect(PublishRouting.diff(current, next)).toEqual({
      put: [
        ["changed.edu", { redirect: "same.edu" }],
        ["new.edu", { script: "app" }],
      ],
      remove: ["gone.edu"],
    })
  })
})

describe("PublishRouting.parseValue", () => {
  test("reads JSON and legacy strings", () => {
    expect(PublishRouting.parseValue('{"script":"a"}')).toEqual({ script: "a" })
    expect(PublishRouting.parseValue('{"redirect":"h.edu"}')).toEqual({ redirect: "h.edu" })
    expect(PublishRouting.parseValue("my-app")).toEqual({ script: "my-app" })
    expect(PublishRouting.parseValue("{broken")).toBeUndefined()
    expect(PublishRouting.parseValue(PublishRouting.serialize({ script: "x" }))).toEqual({ script: "x" })
  })

  test("resolveScript skips reserved and nested labels", () => {
    expect(PublishRouting.resolveScript("Site.omai.ch", zone)).toBe("site")
    expect(PublishRouting.resolveScript("domains.omai.ch", zone)).toBeUndefined()
    expect(PublishRouting.resolveScript("a.b.omai.ch", zone)).toBeUndefined()
    expect(PublishRouting.resolveScript("x.edu", zone)).toBeUndefined()
  })
})
