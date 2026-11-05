import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { Preview } from "../src/preview.js"

describe("Preview", () => {
  test("decodes a command recipe", () => {
    const recipe = Schema.decodeUnknownSync(Preview.Recipe)({
      root: ".",
      kind: "command",
      command: "vite --port {port}",
      source: "detected",
    })

    expect(recipe.command).toBe("vite --port {port}")
  })

  test("rejects an unknown source", () => {
    expect(() =>
      Schema.decodeUnknownSync(Preview.Recipe)({ root: ".", kind: "static", source: "magic" }),
    ).toThrow()
  })

  test("defines omai.preview", () => {
    expect(Preview.Definition.id).toBe("omai.preview")
    expect(Object.keys(Preview.Definition.methods).sort()).toEqual([
      "logs",
      "restart",
      "setRecipe",
      "start",
      "status",
      "stop",
      "ticket",
      "watch",
    ])
  })
})
