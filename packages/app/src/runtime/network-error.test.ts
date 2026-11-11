import { describe, expect, test } from "bun:test"
import { ClientError } from "@opencode/client/promise"
import { isNetworkError } from "./network-error"

describe("isNetworkError", () => {
  test("a request that failed in transit", () => {
    expect(isNetworkError(new ClientError("Transport", { cause: new TypeError("Failed to fetch") }))).toBe(true)
    expect(isNetworkError(new TypeError("Failed to fetch"))).toBe(true)
    expect(isNetworkError(new TypeError("NetworkError when attempting to fetch resource."))).toBe(true)
    expect(isNetworkError(new TypeError("Load failed"))).toBe(true)
  })

  test("found as the cause of another error", () => {
    expect(isNetworkError(new Error("loading failed", { cause: new TypeError("Failed to fetch") }))).toBe(true)
  })

  test("not a bug in the app or an answer from the server", () => {
    expect(isNetworkError(new TypeError("Cannot read properties of undefined (reading 'id')"))).toBe(false)
    expect(isNetworkError(new ClientError("UnexpectedStatus", { detail: "500" }))).toBe(false)
    expect(isNetworkError(new ClientError("MalformedResponse"))).toBe(false)
    expect(isNetworkError("Failed to fetch")).toBe(false)
  })
})
