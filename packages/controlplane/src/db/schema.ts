import { sql } from "drizzle-orm"
import {
  boolean,
  bytea,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core"

const timestamps = {
  created_at: timestamp({ withTimezone: true }).notNull().defaultNow(),
}

export type VmState = "creating" | "running" | "pausing" | "paused" | "resuming" | "failed"

export const UserTable = pgTable("user", {
  id: text().primaryKey(),
  username: text().notNull().unique(),
  email: text().notNull().unique(),
  password_hash: text().notNull(),
  is_disabled: boolean().notNull().default(false),
  permissions: jsonb(),
  deleted_at: timestamp({ withTimezone: true }),
  ...timestamps,
})

export const AuthSessionTable = pgTable(
  "auth_session",
  {
    id: text().primaryKey(),
    user_id: text()
      .notNull()
      .references(() => UserTable.id),
    refresh_hash: text().notNull().unique(),
    last_seen_at: timestamp({ withTimezone: true }).notNull().defaultNow(),
    ended_at: timestamp({ withTimezone: true }),
    ...timestamps,
  },
  (table) => [index("auth_session_user_idx").on(table.user_id)],
)

export const ProjectTable = pgTable(
  "project",
  {
    id: text().primaryKey(),
    user_id: text()
      .notNull()
      .references(() => UserTable.id),
    name: text().notNull(),
    slug: text().notNull(),
    vm_state: text().$type<VmState>().notNull(),
    vm_id: text(),
    vm_host: text(),
    vm_home: text(),
    /** The preview's public origin, for a provider that publishes it (Northflank); null locally. */
    vm_preview: text(),
    vm_error: text(),
    /** The last genuine activity (presence, router traffic, busy work); written at most every 15 s. */
    last_activity_at: timestamp({ withTimezone: true }),
    project_token_hash: text().notNull(),
    last_session_title: text(),
    last_session_at: timestamp({ withTimezone: true }),
    deleted_at: timestamp({ withTimezone: true }),
    ...timestamps,
    updated_at: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("project_live_name_idx")
      .on(table.user_id, sql`lower(${table.name})`)
      .where(sql`${table.deleted_at} is null`),
  ],
)

/** The latest preview screenshot (WebP) each project's VM sent, so the projects page shows it even while the VM sleeps. */
export const ProjectThumbnailTable = pgTable("project_thumbnail", {
  project_id: text()
    .primaryKey()
    .references(() => ProjectTable.id),
  hash: text().notNull(),
  data: bytea().notNull(),
  updated_at: timestamp({ withTimezone: true }).notNull().defaultNow(),
})

/** The models an admin switched on for every user. A model not listed here is off. */
export const PlatformModelTable = pgTable(
  "platform_model",
  {
    provider_id: text().notNull(),
    model_id: text().notNull(),
    updated_at: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.provider_id, table.model_id] })],
)

/** One row per AI step, as each VM reports it. Recorded, not enforced. */
export const ModelUsageTable = pgTable(
  "model_usage",
  {
    id: text().primaryKey(),
    user_id: text().notNull(),
    project_id: text().notNull(),
    provider_id: text().notNull(),
    model_id: text(),
    status: integer().notNull(),
    input_tokens: integer(),
    output_tokens: integer(),
    bytes: integer().notNull(),
    at: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("model_usage_user_idx").on(table.user_id, table.at),
    index("model_usage_project_idx").on(table.project_id),
  ],
)

/** Users' own provider credentials, synced to all of that user's VMs. `value` is sealed; a delete leaves a tombstone. */
/** A user's own switch for one model, kept for every project and browser of theirs. */
export const UserModelTable = pgTable(
  "user_model",
  {
    user_id: text()
      .notNull()
      .references(() => UserTable.id),
    provider_id: text().notNull(),
    model_id: text().notNull(),
    visible: boolean().notNull(),
    updated_at: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.user_id, table.provider_id, table.model_id] })],
)

export const UserCredentialTable = pgTable(
  "user_credential",
  {
    id: text().primaryKey(),
    user_id: text()
      .notNull()
      .references(() => UserTable.id),
    integration_id: text().notNull(),
    label: text().notNull(),
    value: text(),
    updated_at: timestamp({ withTimezone: true }).notNull(),
    deleted_at: timestamp({ withTimezone: true }),
  },
  (table) => [index("user_credential_user_idx").on(table.user_id)],
)

/** A project's published site on the platform zone. Its name is owned here; a deleted site frees the name. */
export const PublishedSiteTable = pgTable(
  "published_site",
  {
    id: text().primaryKey(),
    project_id: text()
      .notNull()
      .references(() => ProjectTable.id),
    user_id: text()
      .notNull()
      .references(() => UserTable.id),
    name: text().notNull(),
    kind: text(),
    published_at: timestamp({ withTimezone: true }),
    updated_at: timestamp({ withTimezone: true }).notNull().defaultNow(),
    deleted_at: timestamp({ withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("published_site_live_name_idx")
      .on(table.name)
      .where(sql`${table.deleted_at} is null`),
    uniqueIndex("published_site_live_project_idx")
      .on(table.project_id)
      .where(sql`${table.deleted_at} is null`),
  ],
)

/** A custom hostname attached to a project's site. Owned here; a deleted one can be added again. */
export const PublishedDomainTable = pgTable(
  "published_domain",
  {
    id: text().primaryKey(),
    project_id: text()
      .notNull()
      .references(() => ProjectTable.id),
    hostname: text().notNull(),
    is_primary: boolean().notNull().default(false),
    /** The Cloudflare custom hostname id. */
    cf_id: text(),
    status: text().notNull(),
    ssl: text().notNull(),
    /** JSON of the ownership verification record. */
    verification: text(),
    error: text(),
    checked_at: timestamp({ withTimezone: true }),
    updated_at: timestamp({ withTimezone: true }).notNull().defaultNow(),
    deleted_at: timestamp({ withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("published_domain_live_hostname_idx")
      .on(table.hostname)
      .where(sql`${table.deleted_at} is null`),
    index("published_domain_project_idx").on(table.project_id),
  ],
)

/**
 * A conversation shared by a public link: a copy of the session as it was when its owner last shared or updated it.
 * Anyone with the link reads it; deleting the row ends the link.
 */
export const SharedSessionTable = pgTable(
  "shared_session",
  {
    id: text().primaryKey(),
    user_id: text()
      .notNull()
      .references(() => UserTable.id),
    project_id: text()
      .notNull()
      .references(() => ProjectTable.id),
    session_id: text().notNull(),
    title: text().notNull(),
    data: jsonb().notNull(),
    ...timestamps,
    updated_at: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("shared_session_project_session_idx").on(table.project_id, table.session_id)],
)
