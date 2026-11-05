import { Project } from "@opencode/schema/project"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiSchema, OpenApi } from "effect/http-api"
import { FileNotFoundError } from "../errors.js"

const EXPERIMENTAL = "Experimental: may change without compatibility guarantees."

const annotations = (identifier: string, summary: string, description: string) =>
  OpenApi.annotations({
    identifier: `experimental.preview.${identifier}`,
    summary,
    description: `${description} ${EXPERIMENTAL}`,
    // The routes share the `server.experimental` group with the persistent PTY prototype; tag them on their own.
    transform: (operation) => ({ ...operation, tags: ["experimental"] }),
  })

export const PreviewThumbnailInfo = Schema.Struct({
  projectID: Project.ID,
  /** Lowercase hex SHA-256 of the image; it changes with every new capture. */
  hash: Schema.String,
  /** When it was captured, in milliseconds since the epoch. */
  time: Schema.Number,
}).annotate({ identifier: "PreviewThumbnailInfo" })

/** Lives in the `server.experimental` group (see `groups/experimental.ts`). */
export const PreviewThumbnailEndpoints = [
  HttpApiEndpoint.get("preview.thumbnails", "/api/experimental/preview/thumbnail", {
    success: Schema.Struct({ data: Schema.Array(PreviewThumbnailInfo) }),
  }).annotateMerge(
    annotations(
      "thumbnails",
      "List preview thumbnails",
      "List the projects that have a screenshot of their app's preview, with each image's hash, without the images.",
    ),
  ),
  HttpApiEndpoint.get("preview.thumbnail", "/api/experimental/preview/thumbnail/:projectID", {
    params: { projectID: Project.ID },
    success: Schema.Uint8Array.pipe(HttpApiSchema.asUint8Array()),
    error: [FileNotFoundError],
  }).annotateMerge(
    annotations(
      "thumbnail",
      "Read preview thumbnail",
      "Read the latest screenshot of a project's app preview as a WebP image, with ETag and 304 Not Modified support. It stays after the preview stops.",
    ),
  ),
] as const
