import { describe, expect, test } from "bun:test"
import { eq } from "drizzle-orm"
import { Auth } from "../src/auth.js"
import { Database } from "../src/db/database.js"
import { UserTable } from "../src/db/schema.js"
import { Users } from "../src/users.js"
import { clock, testConfig } from "./fixture/setup.js"

async function setup(env: Record<string, string> = {}) {
  const db = await Database.memory()
  const time = clock()
  const auth = Auth.make(db, testConfig(env), time.now)
  const user = await Users.create(db, { username: "Ada", email: "Ada@Example.com", password: "pw-123456" })
  return { db, time, auth, user }
}

function issued<T>(value: T) {
  if (typeof value === "string") throw new Error(`expected tokens, got ${value}`)
  return value as Exclude<T, string>
}

describe("Auth", () => {
  test("login by username or email", async () => {
    const s = await setup()
    expect(issued(await s.auth.login({ login: "ada", password: "pw-123456" })).user.id).toBe(s.user.id)
    expect(issued(await s.auth.login({ login: "ADA@example.com", password: "pw-123456" })).user.username).toBe("ada")
    expect(await s.auth.login({ login: "ada", password: "nope" })).toBe("invalid")
    expect(await s.auth.login({ login: "nobody", password: "pw-123456" })).toBe("invalid")
  })

  test("duplicate users are refused", async () => {
    const s = await setup()
    await expect(Users.create(s.db, { username: "ADA", email: "x@y.z", password: "p" })).rejects.toBeInstanceOf(
      Users.UserExists,
    )
  })

  test("disabled user cannot log in or refresh", async () => {
    const s = await setup()
    const tokens = issued(await s.auth.login({ login: "ada", password: "pw-123456" }))
    await s.db.update(UserTable).set({ is_disabled: true }).where(eq(UserTable.id, s.user.id))
    expect(await s.auth.login({ login: "ada", password: "pw-123456" })).toBe("invalid")
    expect(await s.auth.refresh(tokens.refreshToken)).toBe("ended")
    expect(await s.auth.authenticate(tokens.accessToken)).toBeUndefined()
  })

  test("deleted user cannot log in", async () => {
    const s = await setup()
    await s.db.update(UserTable).set({ deleted_at: new Date() }).where(eq(UserTable.id, s.user.id))
    expect(await s.auth.login({ login: "ada", password: "pw-123456" })).toBe("invalid")
  })

  test("signup is refused when the flag is off", async () => {
    const s = await setup()
    expect(await s.auth.signup({ username: "bob", email: "bob@x.y", password: "pw" })).toBe("disabled")
    expect(await s.db.select().from(UserTable).where(eq(UserTable.username, "bob"))).toHaveLength(0)
  })

  test("signup works when the flag is on", async () => {
    const s = await setup({ OMAI_SIGNUP_ENABLED: "true" })
    expect(issued(await s.auth.signup({ username: "bob", email: "bob@x.y", password: "pw" })).user.username).toBe("bob")
    expect(await s.auth.signup({ username: "bob", email: "other@x.y", password: "pw" })).toBe("exists")
  })

  test("idle session ends", async () => {
    const s = await setup()
    const tokens = issued(await s.auth.login({ login: "ada", password: "pw-123456" }))
    const sessionID = (await s.auth.authenticate(tokens.accessToken))!.sessionID
    s.time.advance(900_001)
    expect(await s.auth.refresh(tokens.refreshToken)).toBe("ended")
    expect(await s.auth.sessionLive(sessionID)).toBe(false)
  })

  test("refresh alone does not keep the session alive", async () => {
    const s = await setup()
    const tokens = issued(await s.auth.login({ login: "ada", password: "pw-123456" }))
    s.time.advance(800_000)
    issued(await s.auth.refresh(tokens.refreshToken))
    s.time.advance(200_000)
    expect(await s.auth.refresh(tokens.refreshToken)).toBe("ended")
  })

  test("ping keeps the session alive", async () => {
    const s = await setup()
    const tokens = issued(await s.auth.login({ login: "ada", password: "pw-123456" }))
    s.time.advance(790_000)
    const fresh = issued(await s.auth.refresh(tokens.refreshToken))
    s.time.advance(10_000)
    expect(await s.auth.ping(fresh.accessToken)).toBe(true)
    s.time.advance(800_000)
    expect(issued(await s.auth.refresh(tokens.refreshToken)).user.id).toBe(s.user.id)
  })

  test("access tokens expire after 5 minutes", async () => {
    const s = await setup()
    const tokens = issued(await s.auth.login({ login: "ada", password: "pw-123456" }))
    expect(await s.auth.authenticate(tokens.accessToken)).toBeDefined()
    s.time.advance(300_000)
    expect(await s.auth.authenticate(tokens.accessToken)).toBeUndefined()
  })

  test("logout ends the session", async () => {
    const s = await setup()
    const tokens = issued(await s.auth.login({ login: "ada", password: "pw-123456" }))
    await s.auth.logout(tokens.accessToken)
    expect(await s.auth.authenticate(tokens.accessToken)).toBeUndefined()
    expect(await s.auth.refresh(tokens.refreshToken)).toBe("ended")
  })

  test("login and authenticate report admin; setAdmin grants and revokes", async () => {
    const s = await setup()
    const first = issued(await s.auth.login({ login: "ada", password: "pw-123456" }))
    expect(first.user.admin).toBe(false)
    expect((await s.auth.authenticate(first.accessToken))?.admin).toBe(false)
    expect(await Users.setAdmin(s.db, "ADA", true)).toBe(true)
    expect(issued(await s.auth.login({ login: "ada", password: "pw-123456" })).user.admin).toBe(true)
    expect((await s.auth.authenticate(first.accessToken))?.admin).toBe(true)
    await Users.setAdmin(s.db, "ada", false)
    expect((await s.auth.authenticate(first.accessToken))?.admin).toBe(false)
    expect(await Users.setAdmin(s.db, "nobody", true)).toBe(false)
    const admin = await Users.create(s.db, { username: "root", email: "r@x.y", password: "pw-123456", admin: true })
    expect((await s.db.select().from(UserTable).where(eq(UserTable.id, admin.id)))[0]?.permissions).toEqual({
      admin: true,
    })
  })
})
