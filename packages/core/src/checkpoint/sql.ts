import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import type { SessionSchema } from "../session/schema.js"
import type { SessionMessage } from "../session/message.js"
import { SessionTable } from "../session/sql.js"

/** A session that holds an abandoned path of another session's history. Branch sessions are hidden from every session list. */
export const CheckpointBranchTable = sqliteTable(
  "checkpoint_branch",
  {
    session_id: text()
      .$type<SessionSchema.ID>()
      .primaryKey()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    root_session_id: text()
      .$type<SessionSchema.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    parent_session_id: text().$type<SessionSchema.ID>().notNull(),
    /** The checkpoint key it branched at; empty when it branched before the first checkpoint. */
    boundary_key: text().notNull(),
    /** The staged revert this path had. */
    revert_message_id: text().$type<SessionMessage.ID>(),
    time_created: integer().notNull(),
  },
  (table) => [index("checkpoint_branch_root_idx").on(table.root_session_id)],
)
