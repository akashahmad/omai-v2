import { describe, expect, test } from "bun:test"
import type { Publish } from "@opencode/schema/publish"
import { pill, sortDomains, suggestion } from "./model"

const domain = (input: Partial<Publish.Domain> = {}): Publish.Domain => ({
  hostname: "www.shop.ch",
  primary: false,
  status: "pending",
  ssl: "pending",
  apex: false,
  records: [],
  ...input,
})

const record = (ok?: boolean): Publish.DnsRecord => ({
  type: "CNAME",
  name: "www.shop.ch",
  value: "domains.omai.ch",
  ok,
})

describe("pill", () => {
  test("pill reports dns before certificate", () => {
    expect(pill(domain({ records: [record(true), record(false)] }))).toBe("dns")
    expect(pill(domain({ records: [record(true)] }))).toBe("certificate")
    expect(pill(domain({ records: [record(true)], ssl: "active" }))).toBe("certificate")
  })

  test("an active domain is active and a failed one is an error, whatever its records say", () => {
    expect(pill(domain({ status: "active", ssl: "active", records: [record(false)] }))).toBe("active")
    expect(pill(domain({ status: "error", records: [record(false)] }))).toBe("error")
  })
})

describe("suggestion", () => {
  test("suggestion offers www for an apex and nothing for a subdomain", () => {
    expect(suggestion("xyz.edu")).toEqual({ apex: "xyz.edu", www: "www.xyz.edu" })
    expect(suggestion("  https://Shop.co.uk/ ")).toEqual({ apex: "shop.co.uk", www: "www.shop.co.uk" })
    expect(suggestion("www.xyz.edu")).toBeUndefined()
    expect(suggestion("shop.xyz.edu")).toBeUndefined()
    expect(suggestion("www.shop.co.uk")).toBeUndefined()
    expect(suggestion("localhost")).toBeUndefined()
    expect(suggestion("")).toBeUndefined()
  })
})

describe("sortDomains", () => {
  test("sortDomains puts the primary first", () => {
    const sorted = sortDomains([
      domain({ hostname: "b.ch" }),
      domain({ hostname: "z.ch", primary: true }),
      domain({ hostname: "a.ch" }),
    ])

    expect(sorted.map((item) => item.hostname)).toEqual(["z.ch", "a.ch", "b.ch"])
  })
})
