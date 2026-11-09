import { describe, expect, test } from "bun:test"
import { inheritedRegions } from "./inherit-regions"

describe("inheritedRegions", () => {
  const regions = { a: { side: true, sessionWidth: 520 }, b: { side: false } }

  test("a new tab starts with the layout of the tab it was opened from", () => {
    expect(inheritedRegions(regions, "a", "new")).toEqual({ side: true, sessionWidth: 520 })
  })

  test("a tab with its own layout keeps it", () => {
    expect(inheritedRegions(regions, "a", "b")).toBeUndefined()
  })

  test("nothing to copy from a tab without a layout, or onto itself", () => {
    expect(inheritedRegions(regions, "none", "new")).toBeUndefined()
    expect(inheritedRegions(regions, "a", "a")).toBeUndefined()
  })
})
