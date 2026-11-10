import { and, asc, eq, isNull } from "drizzle-orm"
import { hashPassword } from "./password.js"
import type { Db } from "./db/database.js"
import { AuthSessionTable, UserTable } from "./db/schema.js"

export * as Users from "./users.js"

export class UserExists extends Error {
  constructor() {
    super("A user with this username or email already exists")
  }
}

export type ModelKey = { providerID: string; modelID: string }

/**
 * What an admin set for a user: admin rights, the parts of the app hidden from them (plugin and settings page ids),
 * and the one shared model they are locked to. Admins are never restricted.
 */
export type Permissions = { admin: boolean; hidden: string[]; model: ModelKey | null }

/** A user as the admin's Users page lists them. */
export type Listed = { id: string; username: string; email: string; createdAt: number } & Permissions

/** Usernames and emails are stored lowercased, so lookups and uniqueness ignore case. */
export async function create(
  db: Db,
  input: {
    username: string
    email: string
    password: string
    admin?: boolean
    hidden?: string[]
    model?: ModelKey | null
  },
) {
  const id = crypto.randomUUID()
  const stored = store({ admin: input.admin === true, hidden: input.hidden ?? [], model: input.model ?? null })
  await db
    .insert(UserTable)
    .values({
      id,
      username: input.username.trim().toLowerCase(),
      email: input.email.trim().toLowerCase(),
      password_hash: await hashPassword(input.password),
      ...(stored ? { permissions: stored } : {}),
    })
    .catch((error: unknown) => {
      throw uniqueViolation(error) ? new UserExists() : error
    })
  return { id }
}

/** Grants or revokes admin (setting up the platform's providers and models). False when there is no such user. */
export async function setAdmin(db: Db, username: string, admin: boolean) {
  const user = (await db.select().from(UserTable).where(eq(UserTable.username, username.trim().toLowerCase())))[0]
  if (!user) return false
  await db
    .update(UserTable)
    .set({ permissions: { ...permissions(user.permissions), admin } })
    .where(eq(UserTable.id, user.id))
  return true
}

/** Whether a user row's permissions make it an admin. */
export function isAdmin(value: unknown) {
  return permissions(value).admin === true
}

/** A stored permissions value, read once: unknown fields are ignored and an admin carries no restrictions. */
export function read(value: unknown): Permissions {
  const stored = permissions(value)
  const admin = stored.admin === true
  if (admin) return { admin, hidden: [], model: null }
  const hidden = Array.isArray(stored.hidden) ? stored.hidden.filter((item) => typeof item === "string") : []
  return { admin, hidden, model: modelKey(stored.model) }
}

/** Every live user, oldest first, for the admin's Users page. */
export async function list(db: Db): Promise<Listed[]> {
  const rows = await db.select().from(UserTable).where(isNull(UserTable.deleted_at)).orderBy(asc(UserTable.created_at))
  return rows.map(listed)
}

/** Changes a user's role, restrictions or password. Undefined when there is no such live user. */
export async function update(
  db: Db,
  id: string,
  input: { admin?: boolean; hidden?: string[]; model?: ModelKey | null; password?: string },
): Promise<Listed | undefined> {
  const user = (
    await db
      .select()
      .from(UserTable)
      .where(and(eq(UserTable.id, id), isNull(UserTable.deleted_at)))
  )[0]
  if (!user) return undefined
  const current = read(user.permissions)
  const next = {
    admin: input.admin ?? current.admin,
    hidden: input.hidden ?? current.hidden,
    model: input.model === undefined ? current.model : input.model,
  }
  const rows = await db
    .update(UserTable)
    .set({
      // Other keys a future version stored stay as they were.
      permissions: { ...permissions(user.permissions), ...next },
      ...(input.password ? { password_hash: await hashPassword(input.password) } : {}),
    })
    .where(eq(UserTable.id, id))
    .returning()
  // A new password signs the user out everywhere.
  if (input.password) await endSessions(db, id)
  return rows[0] && listed(rows[0])
}

/**
 * Deletes a user: their sign-ins end at once, and their username and email are freed for a new account. Their projects
 * stay in the database, as a deleted project's do.
 */
export async function remove(db: Db, id: string) {
  const rows = await db
    .update(UserTable)
    .set({ deleted_at: new Date(), username: `deleted-${id}`, email: `deleted-${id}@deleted.invalid` })
    .where(and(eq(UserTable.id, id), isNull(UserTable.deleted_at)))
    .returning({ id: UserTable.id })
  if (rows.length === 0) return false
  await endSessions(db, id)
  return true
}

async function endSessions(db: Db, userID: string) {
  await db
    .update(AuthSessionTable)
    .set({ ended_at: new Date() })
    .where(and(eq(AuthSessionTable.user_id, userID), isNull(AuthSessionTable.ended_at)))
}

function listed(row: typeof UserTable.$inferSelect): Listed {
  return {
    id: row.id,
    username: row.username,
    email: row.email,
    createdAt: row.created_at.getTime(),
    ...read(row.permissions),
  }
}

// Only what differs from a plain member is stored.
function store(value: Permissions) {
  if (value.admin) return { admin: true }
  if (value.hidden.length === 0 && !value.model) return undefined
  return { admin: false, hidden: value.hidden, model: value.model }
}

function modelKey(value: unknown): ModelKey | null {
  if (typeof value !== "object" || value === null) return null
  const providerID = "providerID" in value ? value.providerID : undefined
  const modelID = "modelID" in value ? value.modelID : undefined
  return typeof providerID === "string" && typeof modelID === "string" ? { providerID, modelID } : null
}

function permissions(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

export function uniqueViolation(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  if ("code" in error && error.code === "23505") return true
  return uniqueViolation(error.cause)
}
