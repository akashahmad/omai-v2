import { randomBytes } from "node:crypto"
import { and, eq, isNull } from "drizzle-orm"
import type { Db } from "./db/database.js"
import { ProjectTable, SharedSessionTable } from "./db/schema.js"

export * as Shares from "./shares.js"

/** A shared conversation as its public page reads it. `data` is the session and its messages, as the app sent them. */
export type Shared = { id: string; title: string; data: unknown; sharedAt: number }

/**
 * Conversations shared by a public link. The owner's browser sends a copy of the session when it shares it and again
 * when it updates the link; the copy is what anyone with the link sees, even while the project's VM sleeps.
 */
export function make(db: Db) {
  // Only a live project's owner shares from it, and a deleted project's links end with it.
  async function owned(userID: string, projectID: string) {
    const rows = await db
      .select({ id: ProjectTable.id })
      .from(ProjectTable)
      .where(and(eq(ProjectTable.id, projectID), eq(ProjectTable.user_id, userID), isNull(ProjectTable.deleted_at)))
    return rows.length > 0
  }

  return {
    /** The link's id for a session the user shared, undefined when it is not shared or not theirs. */
    async find(userID: string, projectID: string, sessionID: string) {
      if (!(await owned(userID, projectID))) return undefined
      const row = (
        await db
          .select({ id: SharedSessionTable.id, updatedAt: SharedSessionTable.updated_at })
          .from(SharedSessionTable)
          .where(and(eq(SharedSessionTable.project_id, projectID), eq(SharedSessionTable.session_id, sessionID)))
      )[0]
      return row && { id: row.id, sharedAt: row.updatedAt.getTime() }
    },

    /** Shares a session, or replaces the copy behind its existing link. Undefined when the project is not theirs. */
    async put(userID: string, projectID: string, sessionID: string, input: { title: string; data: unknown }) {
      if (!(await owned(userID, projectID))) return undefined
      const now = new Date()
      const rows = await db
        .insert(SharedSessionTable)
        .values({
          id: randomBytes(12).toString("base64url"),
          user_id: userID,
          project_id: projectID,
          session_id: sessionID,
          title: input.title,
          data: input.data,
          created_at: now,
          updated_at: now,
        })
        .onConflictDoUpdate({
          target: [SharedSessionTable.project_id, SharedSessionTable.session_id],
          set: { title: input.title, data: input.data, updated_at: now },
        })
        .returning({ id: SharedSessionTable.id })
      return rows[0] && { id: rows[0].id, sharedAt: now.getTime() }
    },

    /** Ends a session's link. False when it was not shared or not theirs. */
    async remove(userID: string, projectID: string, sessionID: string) {
      if (!(await owned(userID, projectID))) return false
      const rows = await db
        .delete(SharedSessionTable)
        .where(and(eq(SharedSessionTable.project_id, projectID), eq(SharedSessionTable.session_id, sessionID)))
        .returning({ id: SharedSessionTable.id })
      return rows.length > 0
    },

    /** A shared conversation by its link id, for anyone. Undefined once the link ended or its project was deleted. */
    async read(id: string): Promise<Shared | undefined> {
      const row = (
        await db
          .select({ share: SharedSessionTable })
          .from(SharedSessionTable)
          .innerJoin(ProjectTable, eq(ProjectTable.id, SharedSessionTable.project_id))
          .where(and(eq(SharedSessionTable.id, id), isNull(ProjectTable.deleted_at)))
      )[0]
      if (!row) return undefined
      return {
        id: row.share.id,
        title: row.share.title,
        data: row.share.data,
        sharedAt: row.share.updated_at.getTime(),
      }
    },
  }
}

export type Shares = ReturnType<typeof make>
