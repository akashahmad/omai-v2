import { Schema } from "effect"
import { HttpApiEndpoint, OpenApi } from "effect/http-api"
import { ConflictError, FileNotFoundError, InvalidRequestError } from "../errors.js"

const EXPERIMENTAL = "Experimental: may change without compatibility guarantees."

const annotations = (identifier: string, summary: string, description: string) =>
  OpenApi.annotations({
    identifier: `experimental.project-vm.${identifier}`,
    summary,
    description: `${description} ${EXPERIMENTAL}`,
    transform: (operation) => ({ ...operation, tags: ["experimental"] }),
  })

export const ProjectVmInit = Schema.Struct({
  /** Absolute path of the project folder on the MicroVM. */
  directory: Schema.String,
  /** False when the project was already initialised by an earlier call. */
  created: Schema.Boolean,
}).annotate({ identifier: "ProjectVmInit" })

export const ProjectVmUpload = Schema.Struct({ files: Schema.Number }).annotate({ identifier: "ProjectVmUpload" })

export const ProjectVmBusy = Schema.Struct({
  busy: Schema.Boolean,
  /** Why, e.g. `sessions:1`, `install`, `publish`, `preview` or `terminal:<program>`. */
  reasons: Schema.Array(Schema.String),
}).annotate({ identifier: "ProjectVmBusy" })

/**
 * Only on a project's MicroVM (`OMAI_PROJECT_SLUG` set); elsewhere they answer 404. Lives in the
 * `server.experimental` group (see `groups/experimental.ts`).
 */
export const ProjectVmEndpoints = [
  HttpApiEndpoint.post("projectVm.init", "/api/experimental/project-vm/init", {
    success: ProjectVmInit,
    error: [FileNotFoundError],
  }).annotateMerge(
    annotations(
      "init",
      "Initialise the project folder",
      "Create this MicroVM's project folder and, unless it is already a git repository, initialise git with a first commit. Later calls change nothing.",
    ),
  ),
  HttpApiEndpoint.post("projectVm.upload", "/api/experimental/project-vm/upload", {
    // The raw `application/zip` body is streamed by the handler, so no payload schema is declared.
    success: ProjectVmUpload,
    error: [FileNotFoundError, ConflictError, InvalidRequestError],
  }).annotateMerge(
    annotations(
      "upload",
      "Upload the project's starting files",
      "Unpack a zip (the raw request body, at most 500 MiB) into the project folder before it is initialised. Rejects zips with absolute, escaping or symlink entries without writing anything, and answers 409 once the project is initialised.",
    ),
  ),
  HttpApiEndpoint.get("projectVm.busy", "/api/experimental/project-vm/busy", {
    success: ProjectVmBusy,
    error: [FileNotFoundError],
  }).annotateMerge(
    annotations(
      "busy",
      "Report whether the VM is busy",
      "Whether this MicroVM is doing work or in use, so the control plane doesn't pause it: running session steps, installs, publishes, programs running in terminals, and a preview viewed in the last 2 minutes.",
    ),
  ),
] as const
