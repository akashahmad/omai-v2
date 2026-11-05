export * as CheckpointBranch from "./branch.js"

import { eq } from "drizzle-orm"
import { Effect } from "effect"
import type { Database } from "../database/database.js"
import type { SessionSchema } from "../session/schema.js"
import { CheckpointBranchTable } from "./sql.js"

type DatabaseService = Database.Interface["db"]
export type Row = typeof CheckpointBranchTable.$inferSelect

export const record = (db: DatabaseService, row: typeof CheckpointBranchTable.$inferInsert) =>
  db.insert(CheckpointBranchTable).values(row).run().pipe(Effect.orDie, Effect.asVoid)

/** Re-describes a branch after a path swap changed which path it holds. */
export const update = (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  values: Pick<Row, "parent_session_id" | "boundary_key" | "revert_message_id">,
) =>
  db
    .update(CheckpointBranchTable)
    .set(values)
    .where(eq(CheckpointBranchTable.session_id, sessionID))
    .run()
    .pipe(Effect.orDie, Effect.asVoid)

export const forRoot = (db: DatabaseService, rootID: SessionSchema.ID) =>
  db
    .select()
    .from(CheckpointBranchTable)
    .where(eq(CheckpointBranchTable.root_session_id, rootID))
    .all()
    .pipe(Effect.orDie)

/** A session that isn't a branch is its own root. */
export const rootOf = Effect.fnUntraced(function* (db: DatabaseService, sessionID: SessionSchema.ID) {
  const row = yield* db
    .select({ root: CheckpointBranchTable.root_session_id })
    .from(CheckpointBranchTable)
    .where(eq(CheckpointBranchTable.session_id, sessionID))
    .get()
    .pipe(Effect.orDie)
  return row ? row.root : sessionID
})
