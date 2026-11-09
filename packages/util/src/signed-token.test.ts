import { describe, expect, test } from "bun:test"
import { SignedToken } from "./signed-token.js"

const keys = SignedToken.generateKeyPair()
const claims = {
  typ: "vm" as const,
  sub: "user-1",
  pid: "project-1",
  sid: "session-1",
  host: "http://127.0.0.1:5000",
  exp: Math.floor(Date.now() / 1000) + 60,
}

describe("SignedToken", () => {
  test("round trips vm claims", () => {
    expect(SignedToken.verify(SignedToken.sign(claims, keys.privateKeyPem), keys.publicKeyPem)).toEqual(claims)
  })

  test("round trips access claims", () => {
    const access = { typ: "access" as const, sub: "user-1", sid: "session-1", exp: claims.exp }
    expect(SignedToken.verify(SignedToken.sign(access, keys.privateKeyPem), keys.publicKeyPem)).toEqual(access)
  })

  test("rejects a tampered payload", () => {
    const token = SignedToken.sign(claims, keys.privateKeyPem)
    const tampered = (token[0] === "e" ? "f" : "e") + token.slice(1)
    expect(SignedToken.verify(tampered, keys.publicKeyPem)).toBeUndefined()
  })

  test("rejects another key", () => {
    const other = SignedToken.generateKeyPair()
    expect(SignedToken.verify(SignedToken.sign(claims, keys.privateKeyPem), other.publicKeyPem)).toBeUndefined()
  })

  test("rejects expired", () => {
    const token = SignedToken.sign(claims, keys.privateKeyPem)
    expect(SignedToken.verify(token, keys.publicKeyPem, claims.exp * 1000)).toBeUndefined()
  })

  test("rejects garbage", () => {
    expect(SignedToken.verify("", keys.publicKeyPem)).toBeUndefined()
    expect(SignedToken.verify("a", keys.publicKeyPem)).toBeUndefined()
    expect(SignedToken.verify("a.b.c", keys.publicKeyPem)).toBeUndefined()
  })
})
