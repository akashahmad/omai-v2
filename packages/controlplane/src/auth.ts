import { createHash, randomBytes } from "node:crypto"
import { and, eq, isNull, or } from "drizzle-orm"
import { SignedToken } from "@opencode/util/signed-token"
import type { Config } from "./config.js"
import type { Db } from "./db/database.js"
import { AuthSessionTable, UserTable } from "./db/schema.js"
import { verifyPassword } from "./password.js"
import { Users } from "./users.js"

export * as Auth from "./auth.js"

export type Issued = {
  accessToken: string
  refreshToken: string
  user: { id: string; username: string; email: string; admin: boolean }
}

export type Auth = ReturnType<typeof make>

const ACCESS_TTL_SECONDS = 5 * 60

/**
 * Sessions stay live while the browser pings. Refreshing the access token does not count as
 * activity, so a tab left open still ends after `sessionIdleMs`.
 */
export function make(db: Db, config: Config, now = () => Date.now()) {
  const hash = (token: string) => createHash("sha256").update(token).digest("hex")

  async function issue(user: UserRow): Promise<Issued> {
    const refreshToken = randomBytes(32).toString("base64url")
    const sessionID = crypto.randomUUID()
    await db.insert(AuthSessionTable).values({
      id: sessionID,
      user_id: user.id,
      refresh_hash: hash(refreshToken),
      last_seen_at: new Date(now()),
      created_at: new Date(now()),
    })
    return { accessToken: access(user.id, sessionID), refreshToken, user: view(user) }
  }

  function access(userID: string, sessionID: string) {
    return SignedToken.sign(
      { typ: "access", sub: userID, sid: sessionID, exp: Math.floor(now() / 1000) + ACCESS_TTL_SECONDS },
      config.signingKey,
    )
  }

  /** The session and its user when the session is live; ends an idle session as a side effect. */
  async function live(where: ReturnType<typeof eq>) {
    const row = (
      await db
        .select({ session: AuthSessionTable, user: UserTable })
        .from(AuthSessionTable)
        .innerJoin(UserTable, eq(UserTable.id, AuthSessionTable.user_id))
        .where(where)
    )[0]
    if (!row || row.session.ended_at) return undefined
    const idle = now() - row.session.last_seen_at.getTime() > config.sessionIdleMs
    if (!idle && !row.user.is_disabled && !row.user.deleted_at) return row
    await end(row.session.id)
    return undefined
  }

  async function end(sessionID: string) {
    await db
      .update(AuthSessionTable)
      .set({ ended_at: new Date(now()) })
      .where(and(eq(AuthSessionTable.id, sessionID), isNull(AuthSessionTable.ended_at)))
  }

  async function authenticate(accessToken: string) {
    const claims = SignedToken.verify(accessToken, config.publicKey, now())
    if (claims?.typ !== "access") return undefined
    const row = await live(eq(AuthSessionTable.id, claims.sid))
    if (!row || row.user.id !== claims.sub) return undefined
    return { userID: row.user.id, sessionID: row.session.id, admin: Users.isAdmin(row.user.permissions) }
  }

  return {
    async login(input: { login: string; password: string }): Promise<Issued | "invalid"> {
      const login = input.login.trim().toLowerCase()
      const user = (
        await db
          .select()
          .from(UserTable)
          .where(or(eq(UserTable.username, login), eq(UserTable.email, login)))
      )[0]
      if (!user || user.is_disabled || user.deleted_at) return "invalid"
      if (!(await verifyPassword(input.password, user.password_hash))) return "invalid"
      return issue(user)
    },

    async signup(input: {
      username: string
      email: string
      password: string
    }): Promise<Issued | "disabled" | "exists"> {
      if (!config.signupEnabled) return "disabled"
      const created = await Users.create(db, input).catch((error: unknown) => {
        if (error instanceof Users.UserExists) return undefined
        throw error
      })
      if (!created) return "exists"
      return issue({
        id: created.id,
        username: input.username.trim().toLowerCase(),
        email: input.email.trim().toLowerCase(),
        permissions: null,
      })
    },

    async refresh(refreshToken: string): Promise<Issued | "ended"> {
      const row = await live(eq(AuthSessionTable.refresh_hash, hash(refreshToken)))
      if (!row) return "ended"
      return { accessToken: access(row.user.id, row.session.id), refreshToken, user: view(row.user) }
    },

    async ping(accessToken: string) {
      const session = await authenticate(accessToken)
      if (!session) return false
      await db
        .update(AuthSessionTable)
        .set({ last_seen_at: new Date(now()) })
        .where(eq(AuthSessionTable.id, session.sessionID))
      return true
    },

    async logout(accessToken: string) {
      const claims = SignedToken.verify(accessToken, config.publicKey, now())
      if (claims?.typ !== "access") return
      await end(claims.sid)
    },

    authenticate,

    /** Whether a session is live; with `admin`, also that its user is still an admin (for the platform server). */
    async sessionLive(sessionID: string, options: { admin?: boolean } = {}) {
      const row = await live(eq(AuthSessionTable.id, sessionID))
      if (!row) return false
      return !options.admin || Users.isAdmin(row.user.permissions)
    },
  }
}

type UserRow = { id: string; username: string; email: string; permissions: unknown }

function view(user: UserRow) {
  return { id: user.id, username: user.username, email: user.email, admin: Users.isAdmin(user.permissions) }
}
