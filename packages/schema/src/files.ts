export * as Files from "./files.js"

import { Schema } from "effect"
import { Rpc } from "./rpc.js"
import { optional } from "./schema.js"

export const ArchiveState = Schema.Literals(["scanning", "zipping", "ready", "failed", "cancelled"])
export type ArchiveState = typeof ArchiveState.Type

export interface Archive extends Schema.Schema.Type<typeof Archive> {}
export const Archive = Schema.Struct({
  id: Schema.String,
  /** The folder the archive holds, relative to the project; empty for the whole project. */
  path: Schema.String,
  /** The suggested file name, such as `my-app.zip`. */
  name: Schema.String,
  state: ArchiveState,
  /** Files written so far. */
  files: Schema.Number,
  /** Files found by the scan; 0 while scanning. */
  total: Schema.Number,
  /** Bytes of file content read so far. */
  bytes: Schema.Number,
  /** Bytes of file content found by the scan. */
  totalBytes: Schema.Number,
  /** The zip's size once it is ready. */
  size: optional(Schema.Number),
  error: optional(Schema.String),
}).annotate({ identifier: "Files.Archive" })

export const FailureKind = Schema.Literals(["not-found", "exists", "invalid", "too-large", "other"])
export type FailureKind = typeof FailureKind.Type

const standard = Schema.toStandardSchemaV1
const Empty = Schema.Struct({})

const errors = {
  "files.failed": standard(Schema.Struct({ kind: FailureKind, message: Schema.String })),
}

/** File actions for the project's file tree, served in the project's Location. Every method can fail with `files.failed`. */
export const Definition = Rpc.define({
  id: "omai.files",
  methods: {
    /** Renames or moves a file or folder inside the project; never overwrites. */
    rename: {
      input: standard(Schema.Struct({ from: Schema.String, to: Schema.String })),
      output: standard(Empty),
      errors,
    },
    /** Deletes a file or folder inside the project. */
    remove: { input: standard(Schema.Struct({ path: Schema.String })), output: standard(Empty), errors },
    /** Starts a zip of the project, or of one folder, or joins the one already building for it. */
    archive: { input: standard(Schema.Struct({ path: optional(Schema.String) })), output: standard(Archive), errors },
    /** Reads one chunk of a ready archive (`id`) or of one project file (`path`), base64 encoded. */
    read: {
      input: standard(Schema.Struct({ id: optional(Schema.String), path: optional(Schema.String), offset: Schema.Number })),
      output: standard(Schema.Struct({ data: Schema.String, size: Schema.Number })),
      errors,
    },
    /** Cancels a running archive or deletes a finished one. */
    release: { input: standard(Schema.Struct({ id: Schema.String })), output: standard(Empty), errors },
  },
  events: {
    archive: { schema: standard(Archive) },
  },
})
