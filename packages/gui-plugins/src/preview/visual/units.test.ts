import { describe, expect, test } from "bun:test"
import { alphaOf, formatLength, parseLength, sameShadow, step, toHex, withAlpha } from "./units"

describe("lengths", () => {
  test("parses px, rem, %, and bare numbers", () => {
    expect(parseLength("12")).toEqual({ value: 12, unit: "px" })
    expect(parseLength("1.5rem")).toEqual({ value: 1.5, unit: "rem" })
    expect(parseLength(" 50 % ")).toEqual({ value: 50, unit: "%" })
    expect(parseLength("-4px")).toEqual({ value: -4, unit: "px" })
  })

  test("auto and garbage are not numbers", () => {
    expect(parseLength("auto")).toBeUndefined()
    expect(parseLength("12 apples")).toBeUndefined()
    expect(parseLength("")).toBeUndefined()
  })

  test("format drops needless decimals", () => {
    expect(formatLength({ value: 12.0, unit: "px" })).toBe("12px")
    expect(formatLength({ value: 1.25, unit: "rem" })).toBe("1.25rem")
    expect(formatLength({ value: 0.1 + 0.2, unit: "em" })).toBe("0.3em")
  })

  test("steps keep the unit", () => {
    expect(step("12px", 1)).toBe("13px")
    expect(step("1.5rem", 1)).toBe("2.5rem")
    expect(step("12px", -10)).toBe("2px")
    expect(step("auto", 1)).toBe("auto")
  })
})

describe("colours", () => {
  test("converts rgb and rgba to hex for the colour picker", () => {
    expect(toHex("rgb(10, 58, 120)")).toBe("#0a3a78")
    expect(toHex("rgba(255, 255, 255, 0.5)")).toBe("#ffffff")
    expect(toHex("#ABCDEF")).toBe("#abcdef")
    expect(toHex("#abc")).toBe("#aabbcc")
  })

  test("anything else has no hex", () => {
    expect(toHex("transparent")).toBeUndefined()
    expect(toHex("var(--brand)")).toBeUndefined()
  })
})

describe("alpha", () => {
  test("reads the alpha of rgba and transparent colours", () => {
    expect(alphaOf("rgba(0, 0, 0, 0.25)")).toBe(0.25)
    expect(alphaOf("rgb(0 0 0 / 0.5)")).toBe(0.5)
    expect(alphaOf("rgb(10, 58, 120)")).toBe(1)
    expect(alphaOf("#0a3a78")).toBe(1)
    expect(alphaOf("transparent")).toBe(0)
  })

  test("writes hex when opaque and rgb with alpha otherwise", () => {
    expect(withAlpha("#0a3a78", 1)).toBe("#0a3a78")
    expect(withAlpha("#0a3a78", 0.5)).toBe("rgb(10 58 120 / 0.5)")
    expect(withAlpha("#0a3a78", 0)).toBe("rgb(10 58 120 / 0)")
  })
})

describe("shadows", () => {
  test("a preset matches the browser's computed form of it", () => {
    expect(sameShadow("rgba(0, 0, 0, 0.08) 0px 1px 2px 0px", "0 1px 2px rgb(0 0 0 / 0.08)")).toBe(true)
    expect(sameShadow("rgba(0, 0, 0, 0.12) 0px 4px 12px 0px", "0 4px 12px rgb(0 0 0 / 0.12)")).toBe(true)
    expect(sameShadow("none", "none")).toBe(true)
  })

  test("different shadows don't match", () => {
    expect(sameShadow("rgba(0, 0, 0, 0.08) 0px 1px 2px 0px", "0 4px 12px rgb(0 0 0 / 0.12)")).toBe(false)
    expect(sameShadow("rgba(255, 0, 0, 0.08) 0px 1px 2px 0px", "0 1px 2px rgb(0 0 0 / 0.08)")).toBe(false)
    expect(sameShadow("none", "0 1px 2px rgb(0 0 0 / 0.08)")).toBe(false)
  })
})
