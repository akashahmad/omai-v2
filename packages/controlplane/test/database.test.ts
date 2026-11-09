import { describe, expect, test } from "bun:test"
import { eq } from "drizzle-orm"
import { Database } from "../src/db/database.js"
import { ProjectTable, UserTable } from "../src/db/schema.js"

async function user(db: Database.Db, name: string) {
  const id = crypto.randomUUID()
  await db.insert(UserTable).values({ id, username: name, email: `${name}@test.local`, password_hash: "x" })
  return id
}

function project(userID: string, name: string) {
  return {
    id: crypto.randomUUID(),
    user_id: userID,
    name,
    slug: name.toLowerCase(),
    vm_state: "creating" as const,
    project_token_hash: "h",
  }
}

describe("Database", () => {
  test("migrations apply on pglite", async () => {
    const db = await Database.memory()
    const id = await user(db, "ada")
    const rows = await db.select().from(UserTable).where(eq(UserTable.id, id))
    expect(rows[0]?.username).toBe("ada")
    expect(rows[0]?.is_disabled).toBe(false)
  })

  test("live project names are unique per user, case-insensitive", async () => {
    const db = await Database.memory()
    const a = await user(db, "a")
    const b = await user(db, "b")
    const first = project(a, "Shop")
    await db.insert(ProjectTable).values(first)
    await expect(Promise.resolve(db.insert(ProjectTable).values(project(a, "shop")))).rejects.toThrow()
    await db.insert(ProjectTable).values(project(b, "shop"))
    await db.update(ProjectTable).set({ deleted_at: new Date() }).where(eq(ProjectTable.id, first.id))
    await db.insert(ProjectTable).values(project(a, "shop"))
  })
})

// Runs against a real Postgres when OMAI_TEST_DATABASE_URL is set (e.g. the local docker database).
describe.skipIf(!process.env.OMAI_TEST_DATABASE_URL)("Database on Postgres", () => {
  test("migrations apply and the live-name index holds", async () => {
    const db = await Database.open({ databaseUrl: process.env.OMAI_TEST_DATABASE_URL, dataDir: "" })
    const a = await user(db, `pg-${crypto.randomUUID()}`)
    await db.insert(ProjectTable).values(project(a, "Shop"))
    await expect(Promise.resolve(db.insert(ProjectTable).values(project(a, "SHOP")))).rejects.toThrow()
  })
})
