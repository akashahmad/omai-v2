export * as Preview from "./preview.js"

import { Schema } from "effect"
import { Rpc } from "./rpc.js"
import { optional } from "./schema.js"

/** Where a recipe came from, which decides what may replace it. */
export const Source = Schema.Literals(["detected", "picked", "ai", "user", "config"])
export type Source = typeof Source.Type

/** How a project's preview starts. `{port}` in `command` is replaced with the port the supervisor assigns. */
export interface Recipe extends Schema.Schema.Type<typeof Recipe> {}
export const Recipe = Schema.Struct({
  /** The app directory, relative to the project directory. */
  root: Schema.String,
  kind: Schema.Literals(["static", "command"]),
  install: optional(Schema.String),
  command: optional(Schema.String),
  /** A port the command always uses, for commands that ignore the assigned one. */
  port: optional(Schema.Number),
  source: Source,
}).annotate({ identifier: "Preview.Recipe" })

export interface Candidate extends Schema.Schema.Type<typeof Candidate> {}
export const Candidate = Schema.Struct({
  recipe: Recipe,
  framework: Schema.String,
  confidence: Schema.Literals(["high", "medium", "low"]),
  reason: Schema.String,
}).annotate({ identifier: "Preview.Candidate" })

export const State = Schema.Literals([
  "idle",
  "detecting",
  "choosing",
  "installing",
  "starting",
  "running",
  "fixing",
  "failed",
  "stopped",
  // The project has nothing to preview yet, such as an empty folder.
  "empty",
])
export type State = typeof State.Type

export interface Status extends Schema.Schema.Type<typeof Status> {}
export const Status = Schema.Struct({
  state: State,
  /** The project directory the preview belongs to, so clients can tell projects apart in the event stream. */
  directory: optional(Schema.String),
  /** The choices when `state` is "choosing", best first. */
  candidates: optional(Schema.Array(Candidate)),
  recipe: optional(Recipe),
  framework: optional(Schema.String),
  /** The preview listener's port, on the same host as the server. */
  port: optional(Schema.Number),
  /** A full preview origin that replaces host and port, for hosted previews. */
  origin: optional(Schema.String),
  /** Whether the preview listener asks for a ticket before it serves the app. */
  auth: optional(Schema.Boolean),
  /** One plain sentence when `state` is "failed". */
  reason: optional(Schema.String),
  fixing: optional(Schema.Struct({ tries: Schema.Number, startedAt: Schema.Number })),
}).annotate({ identifier: "Preview.Status" })

const standard = Schema.toStandardSchemaV1
const Empty = Schema.Struct({})

/**
 * The preview plugin's RPC, served in the project's Location. Clients read `status`, follow `changed` and `log`, and
 * call `watch` every minute while a preview is on screen so an unwatched preview stops when idle.
 */
export const Definition = Rpc.define({
  id: "omai.preview",
  methods: {
    status: { input: standard(Empty), output: standard(Status) },
    start: {
      input: standard(
        Schema.Struct({
          sessionID: optional(Schema.String),
          candidate: optional(Schema.Number),
          /** Asks the AI again even when it already failed on the project as it is. */
          retry: optional(Schema.Boolean),
        }),
      ),
      output: standard(Status),
    },
    stop: { input: standard(Empty), output: standard(Status) },
    restart: { input: standard(Empty), output: standard(Status) },
    setRecipe: { input: standard(Schema.Struct({ recipe: Schema.NullOr(Recipe) })), output: standard(Status) },
    logs: { input: standard(Empty), output: standard(Schema.Struct({ text: Schema.String })) },
    ticket: { input: standard(Empty), output: standard(Schema.Struct({ ticket: Schema.String })) },
    watch: { input: standard(Empty), output: standard(Schema.Struct({})) },
    /**
     * Saves an image the visual editor uploads into the running app's public folder, under `images/`, and returns its
     * address on the site and its path in the project. Fails with `preview.asset` and a plain message otherwise.
     */
    asset: {
      input: standard(Schema.Struct({ name: Schema.String, base64: Schema.String })),
      output: standard(Schema.Struct({ url: Schema.String, path: Schema.String })),
      errors: { "preview.asset": standard(Empty) },
    },
  },
  events: {
    changed: { schema: standard(Status) },
    log: { schema: standard(Schema.Struct({ chunk: Schema.String, directory: optional(Schema.String) })) },
  },
})
