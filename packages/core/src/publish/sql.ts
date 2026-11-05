import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { Timestamps } from "../database/schema.sql.js"

// Projects are only ever archived, so none of these tables has a foreign key to cascade from.

/** The published site of a project: its reserved name on the platform zone. */
export const PublishSiteTable = sqliteTable("publish_site", {
  project_id: text().primaryKey(),
  name: text().notNull().unique(),
  kind: text(),
  time_published: integer(),
  ...Timestamps,
})

/** One deploy attempt. Only the latest few per project are kept. */
export const PublishDeployTable = sqliteTable(
  "publish_deploy",
  {
    id: text().primaryKey(),
    project_id: text().notNull(),
    status: text().notNull(),
    stage: text(),
    kind: text(),
    error: text(),
    /** JSON array of `{ stage, startedAt, finishedAt? }`. */
    stages: text().notNull(),
    /** The tail of the build output. */
    log: text().notNull().default(""),
    session_id: text(),
    time_started: integer().notNull(),
    time_finished: integer(),
  },
  (table) => [index("publish_deploy_project_idx").on(table.project_id, table.time_started)],
)

/** A custom hostname attached to a project's site. */
export const PublishDomainTable = sqliteTable(
  "publish_domain",
  {
    hostname: text().primaryKey(),
    project_id: text().notNull(),
    is_primary: integer({ mode: "boolean" }).notNull(),
    /** The Cloudflare custom hostname id. */
    cf_id: text(),
    status: text().notNull(),
    ssl: text().notNull(),
    /** JSON of the ownership verification record. */
    verification: text(),
    error: text(),
    time_checked: integer(),
    ...Timestamps,
  },
  (table) => [index("publish_domain_project_idx").on(table.project_id)],
)
