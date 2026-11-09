import { describe, expect, test } from "bun:test"
import { SignedToken } from "@opencode/util/signed-token"
import { ServerAuth } from "@opencode/server/auth"
import { Option, Redacted } from "effect"

test("accepts only the fixed opencode username", () => {
  const config = { password: Option.some("secret"), username: "omai" }
  expect(ServerAuth.authorized({ username: "omai", password: Redacted.make("secret") }, config)).toBe(true)
  expect(ServerAuth.authorized({ username: "custom", password: Redacted.make("secret") }, config)).toBe(false)
})

test("session tokens expire, resist tampering, and are revoked by changing the password", () => {
  const config = { password: Option.some("secret"), username: "omai" }
  const now = Date.now()
  const token = ServerAuth.issueSession(config, now)
  if (!token) throw new Error("Expected a session token")
  expect(ServerAuth.verifySession(token, config, now)).toBe(true)
  expect(ServerAuth.authorized({ username: "omai", password: Redacted.make(token) }, config)).toBe(true)
  expect(ServerAuth.verifySession(token, config, now + ServerAuth.SESSION_TTL_SECONDS * 1000)).toBe(false)
  expect(ServerAuth.verifySession(`${token}x`, config, now)).toBe(false)
  const parts = token.split(".")
  expect(ServerAuth.verifySession(`${Number(parts[0]) + 1}.${parts[1]}`, config, now)).toBe(false)
  expect(ServerAuth.verifySession(token, { ...config, password: Option.some("rotated") }, now)).toBe(false)
  expect(ServerAuth.issueSession({ ...config, password: Option.none() })).toBeUndefined()
})

describe("vm tokens", () => {
  const keys = SignedToken.generateKeyPair()
  const config = { password: Option.none<string>(), username: "omai", vm: { publicKey: keys.publicKeyPem, projectID: "p1" } }
  const token = (claims: Partial<SignedToken.VmClaims> = {}) =>
    SignedToken.sign(
      {
        typ: "vm",
        sub: "u1",
        pid: "p1",
        sid: "s1",
        host: "http://127.0.0.1:1",
        exp: Math.floor(Date.now() / 1000) + 60,
        ...claims,
      },
      keys.privateKeyPem,
    )

  test("a vm makes auth required", () => {
    expect(ServerAuth.required(config)).toBe(true)
    expect(ServerAuth.required({ password: Option.none(), username: "omai" })).toBe(false)
  })

  test("accepts a vm token for its own project", () => {
    expect(ServerAuth.authorized({ username: "omai", password: Redacted.make(token()) }, config)).toBe(true)
    expect(ServerAuth.authorized({ username: "other", password: Redacted.make(token()) }, config)).toBe(false)
  })

  test("rejects a vm token for another project", () => {
    expect(ServerAuth.authorized({ username: "omai", password: Redacted.make(token({ pid: "p2" })) }, config)).toBe(false)
  })

  test("rejects an expired vm token", () => {
    const expired = token({ exp: Math.floor(Date.now() / 1000) - 1 })
    expect(ServerAuth.authorized({ username: "omai", password: Redacted.make(expired) }, config)).toBe(false)
  })

  test("rejects an access token signed by the same key", () => {
    const access = SignedToken.sign(
      { typ: "access", sub: "u1", sid: "s1", exp: Math.floor(Date.now() / 1000) + 60 },
      keys.privateKeyPem,
    )
    expect(ServerAuth.authorized({ username: "omai", password: Redacted.make(access) }, config)).toBe(false)
  })

  test("password auth unchanged when vm is none", () => {
    const plain = { password: Option.some("secret"), username: "omai" }
    expect(ServerAuth.authorized({ username: "omai", password: Redacted.make(token()) }, plain)).toBe(false)
    expect(ServerAuth.authorized({ username: "omai", password: Redacted.make("secret") }, plain)).toBe(true)
  })

  test("vm settings come from the environment only when both are set", () => {
    expect(ServerAuth.vmFromEnv({ OMAI_TOKEN_PUBLIC_KEY: "k", OMAI_PROJECT_ID: "p" })).toEqual({ publicKey: "k", projectID: "p" })
    expect(ServerAuth.vmFromEnv({ OMAI_TOKEN_PUBLIC_KEY: "k" })).toBeUndefined()
    expect(ServerAuth.vmFromEnv({ OMAI_PROJECT_ID: "p", OMAI_TOKEN_PUBLIC_KEY: "" })).toBeUndefined()
  })
})
