import { blob, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { Timestamps } from "../database/schema.sql.js"

/**
 * The latest screenshot of each project's preview, for the projects page; it stays when the preview stops. Projects
 * are only ever archived, so there is no foreign key to cascade from.
 */
export const PreviewThumbnailTable = sqliteTable("preview_thumbnail", {
  project_id: text().primaryKey(),
  /** Lowercase hex SHA-256 of `data`, so the app re-fetches only a changed image. */
  hash: text().notNull(),
  /** A WebP image. */
  data: blob({ mode: "buffer" }).notNull(),
  ...Timestamps,
})
