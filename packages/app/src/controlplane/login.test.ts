import { describe, expect, test } from "bun:test"
import { submitLogin } from "./login"
import { safeNext } from "./session"

const user = { id: "u", username: "ada", email: "ada@x.y", admin: false }

describe("login", () => {
  test("a wrong password shows the invalid message", async () => {
    expect(await submitLogin({ login: async () => "invalid" }, { login: "ada", password: "x" })).toEqual({
      error: "auth.login.invalid",
    })
  })

  test("a network failure shows the generic message", async () => {
    expect(
      await submitLogin({ login: () => Promise.reject(new Error("offline")) }, { login: "ada", password: "x" }),
    ).toEqual({ error: "auth.error.generic" })
  })

  test("success returns the user", async () => {
    expect(await submitLogin({ login: async () => user }, { login: "ada", password: "right" })).toEqual({ user })
  })

  test("success navigates to next, only within the app", () => {
    expect(safeNext("/server/abc/session/1")).toBe("/server/abc/session/1")
    expect(safeNext(undefined)).toBe("/")
    expect(safeNext("//evil.test")).toBe("/")
    expect(safeNext("https://evil.test")).toBe("/")
  })
})
