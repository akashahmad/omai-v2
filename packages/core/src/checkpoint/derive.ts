import { and, asc, eq, lt, sql } from "drizzle-orm"
import { SessionMessage } from "@opencode/schema/session-message"
import { Snapshot } from "@opencode/schema/snapshot"
import { DateTime, Effect, Schema } from "effect"
import type { Database } from "../database/database.js"
import { optional, RelativePath } from "../schema.js"
import { MessageDecodeError } from "../session/error.js"
import type { SessionSchema } from "../session/schema.js"
import { SessionMessageTable } from "../session/sql.js"

export type Checkpoint = {
  key: string
  messageID: SessionMessage.ID
  title: string
  time: number
  files: string[]
  start?: Snapshot.ID
  end?: Snapshot.ID
}

/** What deriving checkpoints reads from a message. Full messages fit it, and so do the rows `readMessages` returns. */
export type Source =
  | { id: SessionMessage.ID; type: "user"; text: string; time: { created: DateTime.Utc } }
  | { id: SessionMessage.ID; type: "assistant"; snapshot?: SessionMessage.Assistant["snapshot"] }
  | { id: SessionMessage.ID; type: Exclude<SessionMessage.Type, "user" | "assistant"> }

type User = Extract<Source, { type: "user" }>
type Step = Extract<Source, { type: "assistant" }>

const TITLE_LENGTH = 80

/** One checkpoint per user request whose finished steps changed files. */
export function deriveCheckpoints(messages: readonly Source[]): Checkpoint[] {
  const requests = messages.reduce<{ user: User; steps: Step[] }[]>((groups, message) => {
    if (message.type === "user") return [...groups, { user: message, steps: [] }]
    if (message.type === "assistant") groups.at(-1)?.steps.push(message)
    return groups
  }, [])

  return requests.flatMap((request) => {
    const snapshots = request.steps.map((step) => step.snapshot)
    const end = snapshots.at(-1)?.end
    const files = [...new Set(snapshots.flatMap((snapshot) => snapshot?.files ?? []))]
    if (!end || files.length === 0) return []
    const time = DateTime.toEpochMillis(request.user.time.created)
    return [
      {
        key: `${time}:${end}`,
        messageID: request.user.id,
        title: (request.user.text.trim().split("\n")[0] ?? "").trim().slice(0, TITLE_LENGTH),
        time,
        files,
        start: snapshots.find((snapshot) => snapshot?.start)?.start,
        end,
      },
    ]
  })
}

const decodeUser = Schema.decodeUnknownEffect(Schema.Struct({ text: Schema.String, created: Schema.Number }))
const decodeSnapshot = Schema.decodeUnknownEffect(
  Schema.NullOr(
    Schema.fromJsonString(
      Schema.Struct({
        start: Snapshot.ID.pipe(optional),
        end: Snapshot.ID.pipe(optional),
        files: Schema.Array(RelativePath).pipe(optional),
      }),
    ),
  ),
)

/**
 * A session's messages in history order, reading only what deriving checkpoints needs: no parts, no media, and only
 * the prompt text and creation time of a user message and the snapshot of a step. `before` stops at that seq.
 */
export const readMessages = Effect.fnUntraced(function* (
  db: Database.Interface["db"],
  sessionID: SessionSchema.ID,
  before?: number,
) {
  const rows = yield* db
    .select({
      id: SessionMessageTable.id,
      type: SessionMessageTable.type,
      text: sql<unknown>`case ${SessionMessageTable.type} when 'user' then json_extract(${SessionMessageTable.data}, '$.text') end`,
      created: sql<unknown>`case ${SessionMessageTable.type} when 'user' then json_extract(${SessionMessageTable.data}, '$.time.created') end`,
      snapshot: sql<unknown>`case ${SessionMessageTable.type} when 'assistant' then json_extract(${SessionMessageTable.data}, '$.snapshot') end`,
    })
    .from(SessionMessageTable)
    .where(
      and(
        eq(SessionMessageTable.session_id, sessionID),
        before === undefined ? undefined : lt(SessionMessageTable.seq, before),
      ),
    )
    .orderBy(asc(SessionMessageTable.seq))
    .all()
    .pipe(Effect.orDie)
  return yield* Effect.forEach(
    rows,
    Effect.fnUntraced(function* (row): Effect.fn.Return<Source, MessageDecodeError> {
      const invalid = () => new MessageDecodeError({ sessionID, messageID: row.id })
      if (row.type === "user") {
        const user = yield* decodeUser({ text: row.text, created: row.created }).pipe(Effect.mapError(invalid))
        return { id: row.id, type: "user", text: user.text, time: { created: DateTime.makeUnsafe(user.created) } }
      }

      if (row.type === "assistant") {
        const snapshot = yield* decodeSnapshot(row.snapshot).pipe(Effect.mapError(invalid))
        return { id: row.id, type: "assistant", snapshot: snapshot ?? undefined }
      }

      return { id: row.id, type: row.type }
    }),
  )
})
