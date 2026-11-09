import { eq } from "drizzle-orm"
import type { Db } from "./db/database.js"
import { UserModelTable } from "./db/schema.js"

export * as UserModels from "./user-models.js"

export type Switch = { providerID: string; modelID: string; visible: boolean }

/** Each user's model switches (shown or hidden in the model picker), the same in all their projects. */
export function make(db: Db) {
  return {
    async list(userID: string): Promise<Switch[]> {
      const rows = await db
        .select({ providerID: UserModelTable.provider_id, modelID: UserModelTable.model_id, visible: UserModelTable.visible })
        .from(UserModelTable)
        .where(eq(UserModelTable.user_id, userID))
      return rows.toSorted((a, b) => `${a.providerID}/${a.modelID}`.localeCompare(`${b.providerID}/${b.modelID}`))
    },

    async set(userID: string, item: Switch) {
      await db
        .insert(UserModelTable)
        .values({ user_id: userID, provider_id: item.providerID, model_id: item.modelID, visible: item.visible })
        .onConflictDoUpdate({
          target: [UserModelTable.user_id, UserModelTable.provider_id, UserModelTable.model_id],
          set: { visible: item.visible, updated_at: new Date() },
        })
    },
  }
}
