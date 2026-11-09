import { mkdir } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import type { PgAsyncDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core"
import type { Config } from "../config.js"

export * as Database from "./database.js"

export type Db = PgAsyncDatabase<PgQueryResultHKT>

const migrationsFolder = fileURLToPath(new URL("../../migration", import.meta.url))

/** Postgres when `databaseUrl` is set, otherwise PGlite stored under `<dataDir>/pg`. */
export async function open(config: Pick<Config, "databaseUrl" | "dataDir">): Promise<Db> {
  if (config.databaseUrl) {
    const { drizzle } = await import("drizzle-orm/node-postgres")
    const { migrate } = await import("drizzle-orm/node-postgres/migrator")
    const db = drizzle(config.databaseUrl)
    await migrate(db, { migrationsFolder })
    return db
  }
  // PGlite under Node does not create missing parents, as on a fresh volume.
  await mkdir(path.join(config.dataDir, "pg"), { recursive: true })
  return pglite(path.join(config.dataDir, "pg"))
}

/** In-memory PGlite, for tests. */
export function memory() {
  return pglite(undefined)
}

async function pglite(dataDir: string | undefined): Promise<Db> {
  const { drizzle } = await import("drizzle-orm/pglite")
  const { migrate } = await import("drizzle-orm/pglite/migrator")
  const db = drizzle(dataDir ? { connection: { dataDir } } : {})
  await migrate(db, { migrationsFolder })
  return db
}
