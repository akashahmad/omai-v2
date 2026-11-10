import { createHash, timingSafeEqual } from "node:crypto"
import { and, desc, eq, inArray, isNull } from "drizzle-orm"
import type { Config } from "./config.js"
import type { Db } from "./db/database.js"
import { ProjectTable, ProjectThumbnailTable, type VmState } from "./db/schema.js"
import { uniqueViolation } from "./users.js"
import { Lifecycle } from "./vm/lifecycle.js"
import type { VmProvider } from "./vm/provider.js"
import { hashToken, provision, vmToken } from "./vm/provision.js"
import { Reserves } from "./vm/reserves.js"

export * as Projects from "./projects.js"

export type ProjectView = {
  id: string
  name: string
  slug: string
  vmState: VmState
  vmError?: string
  lastSession?: { title: string; at: number }
  /** Hash of the latest preview screenshot, when there is one; it changes with every new capture. */
  thumbnail?: string
  createdAt: number
  updatedAt: number
}

export type OpenResult = { routerUrl: string; token: string; directory: string }

export function slugify(name: string) {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 48)
    .replace(/^-+|-+$/g, "")
  return slug || "project"
}

export function make(db: Db, config: Config, provider: VmProvider, now = () => Date.now()) {
  const lifecycle = Lifecycle.make(db, config, provider, now)
  const reserves = Reserves.make(db, config, provider, now)
  // A reserve is not a project yet: its user never sees it, opens it or changes it.
  const owned = (userID: string, projectID: string) =>
    and(
      eq(ProjectTable.id, projectID),
      eq(ProjectTable.user_id, userID),
      isNull(ProjectTable.deleted_at),
      isNull(ProjectTable.reserved_at),
    )

  async function thumbnailHashes(projectIDs: string[]) {
    if (projectIDs.length === 0) return new Map<string, string>()
    const rows = await db
      .select({ id: ProjectThumbnailTable.project_id, hash: ProjectThumbnailTable.hash })
      .from(ProjectThumbnailTable)
      .where(inArray(ProjectThumbnailTable.project_id, projectIDs))
    return new Map(rows.map((item) => [item.id, item.hash]))
  }

  async function row(userID: string, projectID: string) {
    return (await db.select().from(ProjectTable).where(owned(userID, projectID)))[0]
  }

  function start(project: { id: string; user_id: string; slug: string }) {
    // Background work: the caller polls the project's state.
    void provision(db, config, provider, project, now).catch((error: unknown) =>
      console.error(`provisioning ${project.id} failed`, error),
    )
  }

  return {
    lifecycle,
    reserves,

    async list(userID: string) {
      const rows = await db
        .select()
        .from(ProjectTable)
        .where(
          and(eq(ProjectTable.user_id, userID), isNull(ProjectTable.deleted_at), isNull(ProjectTable.reserved_at)),
        )
        .orderBy(desc(ProjectTable.updated_at))
      const hashes = await thumbnailHashes(rows.map((item) => item.id))
      return rows.map((item) => view(item, hashes.get(item.id)))
    },

    async get(userID: string, projectID: string) {
      const found = await row(userID, projectID)
      if (!found) return undefined
      return view(found, (await thumbnailHashes([found.id])).get(found.id))
    },

    /** The project's screenshot for its owner, or undefined. */
    async thumbnail(userID: string, projectID: string) {
      const found = await row(userID, projectID)
      if (!found) return undefined
      return (
        await db
          .select({ hash: ProjectThumbnailTable.hash, data: ProjectThumbnailTable.data })
          .from(ProjectThumbnailTable)
          .where(eq(ProjectThumbnailTable.project_id, projectID))
      )[0]
    },

    /** Stores the screenshot a project's VM sent, replacing the one before. */
    async setThumbnail(projectID: string, data: Uint8Array) {
      const hash = createHash("sha256").update(data).digest("hex")
      const row = { project_id: projectID, hash, data: Buffer.from(data), updated_at: new Date(now()) }
      await db
        .insert(ProjectThumbnailTable)
        .values(row)
        .onConflictDoUpdate({
          target: ProjectThumbnailTable.project_id,
          set: { hash, data: row.data, updated_at: row.updated_at },
        })
    },

    async create(userID: string, name: string): Promise<ProjectView | "exists" | "invalid"> {
      const trimmed = validName(name)
      if (!trimmed) return "invalid"
      // A reserve that already runs opens at once; one still booting carries on as this project.
      const claimed = await reserves.claim(userID, { name: trimmed, slug: slugify(trimmed) })
      if (claimed) return claimed === "exists" ? claimed : view(claimed)
      const at = new Date(now())
      const inserted = await db
        .insert(ProjectTable)
        .values({
          id: crypto.randomUUID(),
          user_id: userID,
          name: trimmed,
          slug: slugify(trimmed),
          vm_state: "creating",
          project_token_hash: "",
          created_at: at,
          updated_at: at,
        })
        .returning()
        .catch((error: unknown) => {
          if (uniqueViolation(error)) return undefined
          throw error
        })
      const project = inserted?.[0]
      if (!project) return "exists"
      start(project)
      return view(project)
    },

    async retry(userID: string, projectID: string) {
      const updated = await db
        .update(ProjectTable)
        .set({ vm_state: "creating", vm_error: null, updated_at: new Date(now()) })
        .where(and(owned(userID, projectID), eq(ProjectTable.vm_state, "failed")))
        .returning()
      const project = updated[0]
      if (!project) return undefined
      start(project)
      return view(project)
    },

    async rename(
      userID: string,
      projectID: string,
      name: string,
    ): Promise<ProjectView | "exists" | "invalid" | undefined> {
      const trimmed = validName(name)
      if (!trimmed) return "invalid"
      const updated = await db
        .update(ProjectTable)
        .set({ name: trimmed, updated_at: new Date(now()) })
        .where(owned(userID, projectID))
        .returning()
        .catch((error: unknown) => {
          if (uniqueViolation(error)) return "exists" as const
          throw error
        })
      if (updated === "exists") return updated
      return updated[0] ? view(updated[0]) : undefined
    },

    /** Soft delete: the row, VM and volume stay; the user no longer sees the project, and its VM pauses. */
    async remove(userID: string, projectID: string) {
      const updated = await db
        .update(ProjectTable)
        .set({ deleted_at: new Date(now()) })
        .where(owned(userID, projectID))
        .returning({ id: ProjectTable.id })
      if (updated.length === 0) return false
      lifecycle.forget(projectID)
      // In the background: the sweeper pauses it later if this fails.
      void lifecycle
        .pause(projectID, "deleted")
        .catch((error: unknown) => console.error(`pausing ${projectID} failed`, error))
      return true
    },

    /** Starts the user's paused project in the background, to hide resume time. False when it isn't theirs. */
    async wake(userID: string, projectID: string) {
      if (!(await row(userID, projectID))) return false
      void lifecycle.resume(projectID).catch((error: unknown) => console.error(`waking ${projectID} failed`, error))
      return true
    },

    async open(userID: string, sessionID: string, projectID: string): Promise<OpenResult | "not-ready" | undefined> {
      const project = await row(userID, projectID)
      if (!project) return undefined
      const address = await lifecycle.resume(projectID)
      if (address === "deleted") return undefined
      if (address === "not-ready") return address
      return {
        routerUrl: `${config.routerUrl}/vm/${projectID}`,
        token: vmToken(config, { userID, projectID, sessionID, host: address.host }, now()),
        directory: `${address.home}/${project.slug}`,
      }
    },

    async setSummary(projectID: string, input: { title: string; at: number }) {
      await db
        .update(ProjectTable)
        .set({ last_session_title: input.title, last_session_at: new Date(input.at), updated_at: new Date(now()) })
        .where(eq(ProjectTable.id, projectID))
    },

    /** A live, running project's server address, for the router; undefined otherwise. */
    async host(projectID: string) {
      const found = (
        await db
          .select({ host: ProjectTable.vm_host, state: ProjectTable.vm_state })
          .from(ProjectTable)
          .where(and(eq(ProjectTable.id, projectID), isNull(ProjectTable.deleted_at), isNull(ProjectTable.reserved_at)))
      )[0]
      return found?.state === "running" && found.host ? found.host : undefined
    },

    /**
     * What a live project's VM may know about itself: the preview's public origin once known, and its folder name
     * (`slug`), which a reserve's VM learns here once the reserve is claimed.
     */
    async vm(projectID: string) {
      const found = (
        await db
          .select({ preview: ProjectTable.vm_preview, slug: ProjectTable.slug, reserved: ProjectTable.reserved_at })
          .from(ProjectTable)
          .where(and(eq(ProjectTable.id, projectID), isNull(ProjectTable.deleted_at)))
      )[0]
      return {
        ...(found?.preview ? { preview: found.preview } : {}),
        ...(found && !found.reserved && found.slug ? { slug: found.slug } : {}),
      }
    },

    /** The user a live project belongs to. */
    async owner(projectID: string) {
      return (
        await db
          .select({ userID: ProjectTable.user_id })
          .from(ProjectTable)
          .where(and(eq(ProjectTable.id, projectID), isNull(ProjectTable.deleted_at)))
      )[0]?.userID
    },

    async verifyProjectToken(projectID: string, token: string) {
      const project = (
        await db
          .select({ hash: ProjectTable.project_token_hash })
          .from(ProjectTable)
          .where(and(eq(ProjectTable.id, projectID), isNull(ProjectTable.deleted_at)))
      )[0]
      if (!project?.hash) return false
      return timingSafeEqual(Buffer.from(project.hash), Buffer.from(hashToken(token)))
    },
  }
}

function validName(name: string) {
  const trimmed = name.trim()
  if (trimmed.length < 1 || trimmed.length > 64) return undefined
  return trimmed
}

function view(row: typeof ProjectTable.$inferSelect, thumbnail?: string): ProjectView {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    vmState: row.vm_state,
    ...(row.vm_error ? { vmError: row.vm_error } : {}),
    ...(row.last_session_title && row.last_session_at
      ? { lastSession: { title: row.last_session_title, at: row.last_session_at.getTime() } }
      : {}),
    ...(thumbnail ? { thumbnail } : {}),
    createdAt: row.created_at.getTime(),
    updatedAt: row.updated_at.getTime(),
  }
}
