import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { Publish } from "../src/publish.js"

describe("Publish", () => {
  test("defines omai.publish and omai.domains", () => {
    expect(Publish.Definition.id).toBe("omai.publish")
    expect(Object.keys(Publish.Definition.methods).sort()).toEqual([
      "available",
      "cancel",
      "log",
      "publish",
      "remove",
      "status",
    ])
    expect(Publish.DomainsDefinition.id).toBe("omai.domains")
    expect(Object.keys(Publish.DomainsDefinition.methods).sort()).toEqual([
      "add",
      "check",
      "list",
      "remove",
      "setPrimary",
    ])
  })

  test("decodes a domain with records", () => {
    const input: Publish.Domain = {
      hostname: "www.example.com",
      primary: true,
      status: "pending",
      ssl: "pending_validation",
      apex: false,
      records: [{ type: "CNAME", name: "www", value: "domains.omai.ch", ok: false }],
      verification: { type: "TXT", name: "_cf-custom-hostname.www", value: "abc" },
    }

    expect(Schema.decodeUnknownSync(Publish.Domain)(input)).toEqual(input)
  })

  test("rejects an unknown deploy status", () => {
    expect(() =>
      Schema.decodeUnknownSync(Publish.Deploy)({ id: "d", status: "weird", startedAt: 1, stages: [] }),
    ).toThrow()
  })
})
