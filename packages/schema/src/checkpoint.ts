export * as Checkpoint from "./checkpoint.js"

import { Schema } from "effect"
import { FileDiff } from "./file-diff.js"
import { Rpc } from "./rpc.js"
import { optional } from "./schema.js"
import { Session } from "./session.js"

/**
 * One checkpoint in a conversation's tree. `current` ones are visible on the path the user is on, `ahead` ones are
 * hidden by a staged revert on that path, and `branch` ones live only on a stored path.
 */
export interface Node extends Schema.Schema.Type<typeof Node> {}
export const Node = Schema.Struct({
  key: Schema.String,
  messageID: Schema.String,
  title: Schema.String,
  /** The request's time in milliseconds. */
  time: Schema.Number,
  files: Schema.Array(Schema.String),
  path: Schema.Literals(["current", "ahead", "branch"]),
  branchID: optional(Schema.String),
  /** The checkpoint before this one on its path. */
  parentKey: optional(Schema.String),
}).annotate({ identifier: "Checkpoint.Node" })

export interface Listing extends Schema.Schema.Type<typeof Listing> {}
export const Listing = Schema.Struct({
  /** False when the project has no git history to restore from. */
  available: Schema.Boolean,
  nodes: Schema.Array(Node),
  current: optional(Schema.String),
}).annotate({ identifier: "Checkpoint.Listing" })

const standard = Schema.toStandardSchemaV1
const Target = Schema.Struct({ sessionID: Session.ID, key: Schema.String })

const errors = {
  "checkpoint.busy": standard(Schema.Struct({ session: Schema.String })),
  "checkpoint.missing": standard(Schema.Struct({})),
  /** The conversation has queued messages that are not delivered yet. */
  "checkpoint.queued": standard(Schema.Struct({})),
}

/**
 * Checkpoints of the sessions in a Location. Every method can fail with `checkpoint.busy`, `checkpoint.queued` or
 * `checkpoint.missing`.
 */
export const Definition = Rpc.define({
  id: "omai.checkpoints",
  methods: {
    list: { input: standard(Schema.Struct({ sessionID: Session.ID })), output: standard(Listing), errors },
    diff: {
      input: standard(
        Schema.Struct({ sessionID: Session.ID, key: Schema.String, mode: Schema.Literals(["change", "now"]) }),
      ),
      output: standard(Schema.Struct({ files: Schema.Array(FileDiff.Info) })),
      errors,
    },
    jump: { input: standard(Target), output: standard(Schema.Struct({})), errors },
    /** `done` is false when there is nothing to undo, or the conversation changed since the jump. */
    undo: {
      input: standard(Schema.Struct({ sessionID: Session.ID })),
      output: standard(Schema.Struct({ done: Schema.Boolean })),
      errors,
    },
  },
  events: {
    changed: { schema: standard(Schema.Struct({ sessionID: Session.ID })) },
  },
})
