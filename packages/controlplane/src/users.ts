import { eq } from "drizzle-orm"
import { hashPassword } from "./password.js"
import type { Db } from "./db/database.js"
import { UserTable } from "./db/schema.js"

export * as Users from "./users.js"

export class UserExists extends Error {
  constructor() {
    super("A user with this username or email already exists")
  }
}

/** Usernames and emails are stored lowercased, so lookups and uniqueness ignore case. */
export async function create(db: Db, input: { username: string; email: string; password: string; admin?: boolean }) {
  const id = crypto.randomUUID()
  await db
    .insert(UserTable)
    .values({
      id,
      username: input.username.trim().toLowerCase(),
      email: input.email.trim().toLowerCase(),
      password_hash: await hashPassword(input.password),
      ...(input.admin ? { permissions: { admin: true } } : {}),
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

function permissions(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

export function uniqueViolation(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  if ("code" in error && error.code === "23505") return true
  return uniqueViolation(error.cause)
}
