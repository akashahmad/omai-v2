import { expect, test } from "bun:test"
import { allowed } from "../src/handlers/platform"

test("the platform's provider keys need its secret, and only the platform server has one", () => {
  expect(allowed("s3cret", "s3cret")).toBe(true)
  expect(allowed("wrong!", "s3cret")).toBe(false)
  expect(allowed("s3cre", "s3cret")).toBe(false)
  expect(allowed(undefined, "s3cret")).toBe(false)
  expect(allowed("s3cret", undefined)).toBe(false)
  expect(allowed("", "")).toBe(false)
})
