export * as PreviewThumbnail from "./thumbnail.js"

import { createHash } from "node:crypto"
import { eq } from "drizzle-orm"
import { Context, Effect, Layer } from "effect"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { Database } from "../database/database.js"
import { PreviewThumbnailTable } from "./sql.js"
import { ProjectVmThumbnail } from "../project-vm/thumbnail.js"

type DatabaseService = Database.Interface["db"]

export interface Interface {
  /** Stores a project's newest preview screenshot (WebP), replacing the one before. */
  readonly save: (projectID: string, data: Uint8Array) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/PreviewThumbnail") {}

/** The image's content hash: lowercase hex SHA-256. */
export const hash = (data: Uint8Array) => createHash("sha256").update(data).digest("hex")

/** One project's screenshot, or undefined when its preview never ran. */
export const read = Effect.fnUntraced(function* (db: DatabaseService, projectID: string) {
  const row = yield* db
    .select({
      hash: PreviewThumbnailTable.hash,
      data: PreviewThumbnailTable.data,
      time: PreviewThumbnailTable.time_updated,
    })
    .from(PreviewThumbnailTable)
    .where(eq(PreviewThumbnailTable.project_id, projectID))
    .get()
    .pipe(Effect.orDie)

  return row && { hash: row.hash, data: new Uint8Array(row.data), time: row.time }
})

/** Which projects have a screenshot and its hash, without the images. */
export const list = Effect.fnUntraced(function* (db: DatabaseService) {
  const rows = yield* db
    .select({
      projectID: PreviewThumbnailTable.project_id,
      hash: PreviewThumbnailTable.hash,
      time: PreviewThumbnailTable.time_updated,
    })
    .from(PreviewThumbnailTable)
    .all()
    .pipe(Effect.orDie)

  return rows
})

/** The newest screenshot of any project here, or undefined. A MicroVM serves one project, so this is its own. */
export const latest = Effect.fnUntraced(function* (db: DatabaseService) {
  const newest = (yield* list(db)).toSorted((a, b) => b.time - a.time)[0]

  if (!newest) return undefined

  return yield* read(db, newest.projectID)
})

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    // On a project's MicroVM every new screenshot also goes to the control plane, for the projects page.
    const vm = ProjectVmThumbnail.target()

    return Service.of({
      save: (projectID, data) => {
        const now = Date.now()
        const row = {
          project_id: projectID,
          hash: hash(data),
          data: Buffer.from(data),
          time_created: now,
          time_updated: now,
        }

        return db
          .insert(PreviewThumbnailTable)
          .values(row)
          .onConflictDoUpdate({
            target: PreviewThumbnailTable.project_id,
            set: { hash: row.hash, data: row.data, time_updated: now },
          })
          .run()
          .pipe(
            Effect.orDie,
            Effect.tap(() => (vm ? Effect.promise(() => ProjectVmThumbnail.push(vm, data)) : Effect.void)),
            Effect.asVoid,
          )
      },
    })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node] })
