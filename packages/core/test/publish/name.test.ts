import { describe, expect, test } from "bun:test"
import { PublishName } from "../../src/publish/name"

describe("publish names", () => {
  test("api and admin are reserved", () => {
    expect(PublishName.validName("api")).toContain("reserved")
    expect(PublishName.validName("admin")).toContain("reserved")
  })

  test("normalizeHostname strips scheme, path, case and trailing dot", () => {
    expect(PublishName.normalizeHostname("https://WWW.Example.com/")).toBe("www.example.com")
    expect(PublishName.normalizeHostname("example.com.")).toBe("example.com")
    expect(PublishName.normalizeHostname("  Http://a.b.com:8080/x?y=1 ")).toBe("a.b.com")
  })

  test("slug falls back to site", () => {
    expect(PublishName.slug("!!!")).toBe("site")
    expect(PublishName.slug("My Cool App")).toBe("my-cool-app")
    expect(PublishName.slug("a".repeat(60))).toHaveLength(40)
    expect(PublishName.slug(`${"a".repeat(39)} b`)).toBe("a".repeat(39))
  })

  test("validName rejects reserved and edge hyphens", () => {
    expect(PublishName.validName("my-app")).toBeUndefined()
    expect(PublishName.validName("a")).toBeUndefined()
    expect(PublishName.validName("-app")).toBeString()
    expect(PublishName.validName("app-")).toBeString()
    expect(PublishName.validName("My-App")).toBeString()
    expect(PublishName.validName("a".repeat(41))).toBeString()
    expect(PublishName.validName("domains")).toContain("reserved")
    expect(PublishName.validName("www")).toContain("reserved")
  })

  test("isHostname needs two valid labels", () => {
    expect(PublishName.isHostname("example.com")).toBe(true)
    expect(PublishName.isHostname("localhost")).toBe(false)
    expect(PublishName.isHostname("-a.com")).toBe(false)
    expect(PublishName.isHostname("a..com")).toBe(false)
  })

  test("isApex knows two-part suffixes", () => {
    expect(PublishName.isApex("example.com")).toBe(true)
    expect(PublishName.isApex("www.example.com")).toBe(false)
    expect(PublishName.isApex("xyz.co.uk")).toBe(true)
    expect(PublishName.isApex("www.xyz.co.uk")).toBe(false)
    expect(PublishName.wwwOf("example.com")).toBe("www.example.com")
  })
})
