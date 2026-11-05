export * as GitTool from "./git-tool.js"

import { Schema } from "effect"
import { Rpc } from "./rpc.js"
import { optional } from "./schema.js"

export const FailureKind = Schema.Literals([
  "auth",
  "diverged",
  "conflict",
  "no-upstream",
  "no-remote",
  "nothing-to-commit",
  "not-a-repo",
  "no-profile",
  "other",
])
export type FailureKind = typeof FailureKind.Type

export interface FileChange extends Schema.Schema.Type<typeof FileChange> {}
export const FileChange = Schema.Struct({
  path: Schema.String,
  oldPath: optional(Schema.String),
  state: Schema.Literals(["added", "modified", "deleted", "renamed", "untracked", "conflicted"]),
  staged: Schema.Boolean,
  unstaged: Schema.Boolean,
  additions: Schema.Number,
  deletions: Schema.Number,
}).annotate({ identifier: "GitTool.FileChange" })

export interface Remote extends Schema.Schema.Type<typeof Remote> {}
export const Remote = Schema.Struct({
  name: Schema.String,
  /** The remote's address with any credentials masked. */
  url: Schema.String,
  /** Whether this is the default push remote. */
  push: Schema.Boolean,
}).annotate({ identifier: "GitTool.Remote" })

export interface Branch extends Schema.Schema.Type<typeof Branch> {}
export const Branch = Schema.Struct({
  name: Schema.String,
  current: Schema.Boolean,
  upstream: optional(Schema.String),
}).annotate({ identifier: "GitTool.Branch" })

export interface Profile extends Schema.Schema.Type<typeof Profile> {}
export const Profile = Schema.Struct({
  name: optional(Schema.String),
  email: optional(Schema.String),
  scope: Schema.Literals(["local", "global", "none"]),
}).annotate({ identifier: "GitTool.Profile" })

export interface Status extends Schema.Schema.Type<typeof Status> {}
export const Status = Schema.Struct({
  repo: Schema.Boolean,
  root: optional(Schema.String),
  branch: optional(Schema.String),
  detached: Schema.Boolean,
  upstream: optional(Schema.String),
  ahead: Schema.Number,
  behind: Schema.Number,
  files: Schema.Array(FileChange),
  remotes: Schema.Array(Remote),
  branches: Schema.Array(Branch),
  profile: Profile,
  operation: optional(Schema.Literals(["merge", "rebase"])),
}).annotate({ identifier: "GitTool.Status" })

export interface Commit extends Schema.Schema.Type<typeof Commit> {}
export const Commit = Schema.Struct({
  hash: Schema.String,
  short: Schema.String,
  subject: Schema.String,
  body: Schema.String,
  author: Schema.String,
  email: Schema.String,
  /** Commit time in milliseconds. */
  time: Schema.Number,
  merge: Schema.Boolean,
}).annotate({ identifier: "GitTool.Commit" })

/** A plain sentence for the toast, such as "Pushed 3 commits to origin/main". */
export interface Result extends Schema.Schema.Type<typeof Result> {}
export const Result = Schema.Struct({ message: Schema.String }).annotate({ identifier: "GitTool.Result" })

const standard = Schema.toStandardSchemaV1
const Empty = Schema.Struct({})
const Paths = Schema.Struct({ paths: Schema.Array(Schema.String) })
const Name = Schema.Struct({ name: Schema.String })
const Remotes = Schema.Struct({ name: Schema.String, url: Schema.String })

const errors = {
  "git.failed": standard(Schema.Struct({ kind: FailureKind, message: Schema.String, details: Schema.String })),
}

/** The Git tool's RPC, served in the project's Location. Every method can fail with `git.failed`. */
export const Definition = Rpc.define({
  id: "omai.git",
  methods: {
    status: { input: standard(Empty), output: standard(Status), errors },
    diff: {
      input: standard(
        Schema.Struct({
          path: Schema.String,
          /** The path a renamed file had before, so the diff shows the real change. */
          oldPath: optional(Schema.String),
          staged: optional(Schema.Boolean),
          commit: optional(Schema.String),
        }),
      ),
      output: standard(Schema.Struct({ before: Schema.String, after: Schema.String, binary: Schema.Boolean })),
      errors,
    },
    stage: {
      input: standard(Schema.Struct({ paths: Schema.Array(Schema.String), staged: Schema.Boolean })),
      output: standard(Empty),
      errors,
    },
    discard: { input: standard(Paths), output: standard(Empty), errors },
    commit: {
      input: standard(Schema.Struct({ message: Schema.String, amend: optional(Schema.Boolean) })),
      output: standard(Result),
      errors,
    },
    profile: {
      input: standard(Schema.Struct({ name: Schema.String, email: Schema.String, global: Schema.Boolean })),
      output: standard(Empty),
      errors,
    },
    push: { input: standard(Schema.Struct({ remote: optional(Schema.String) })), output: standard(Result), errors },
    pull: {
      input: standard(Schema.Struct({ mode: optional(Schema.Literals(["ff-only", "rebase", "merge"])) })),
      output: standard(Result),
      errors,
    },
    fetch: { input: standard(Empty), output: standard(Result), errors },
    abort: { input: standard(Empty), output: standard(Result), errors },
    /** Finishes a rebase or merge whose conflicts are all resolved and staged. */
    continue: { input: standard(Empty), output: standard(Result), errors },
    remoteAdd: { input: standard(Remotes), output: standard(Empty), errors },
    remoteSet: { input: standard(Remotes), output: standard(Empty), errors },
    remoteRemove: { input: standard(Name), output: standard(Empty), errors },
    branchCreate: { input: standard(Name), output: standard(Empty), errors },
    branchSwitch: { input: standard(Name), output: standard(Empty), errors },
    log: {
      input: standard(Schema.Struct({ skip: optional(Schema.Number), limit: optional(Schema.Number) })),
      output: standard(Schema.Struct({ commits: Schema.Array(Commit), more: Schema.Boolean })),
      errors,
    },
    show: {
      input: standard(Schema.Struct({ hash: Schema.String })),
      output: standard(Schema.Struct({ commit: Commit, files: Schema.Array(FileChange) })),
      errors,
    },
    init: { input: standard(Empty), output: standard(Empty), errors },
  },
  events: {
    changed: { schema: standard(Status) },
  },
})
