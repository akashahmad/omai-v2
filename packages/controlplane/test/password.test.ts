import { describe, expect, test } from "bun:test"
import { hashPassword, verifyPassword } from "../src/password.js"

const vector =
  "00112233445566778899aabbccddeeff:3e19ebeabf15ad17c24de695284e79441c0d80c6d98b95a3c052c58a0d57b09f83b0742a5805af28a0b5bbcf673af62819b91eb830a104fb0bb42def767f52aa"

describe("password", () => {
  test("verifies the old project's hash format", async () => {
    expect(await verifyPassword("correct horse", vector)).toBe(true)
    expect(await verifyPassword("wrong", vector)).toBe(false)
  })

  test("hashPassword output matches the format", async () => {
    const hash = await hashPassword("secret")
    expect(hash).toMatch(/^[a-f0-9]{32}:[a-f0-9]{128}$/)
    expect(await verifyPassword("secret", hash)).toBe(true)
  })

  test("malformed stored hashes never verify", async () => {
    expect(await verifyPassword("x", "")).toBe(false)
    expect(await verifyPassword("x", "abc:def")).toBe(false)
  })
})
