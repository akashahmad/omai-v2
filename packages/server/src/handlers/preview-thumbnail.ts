import { Database } from "@opencode/core/database/database"
import { PreviewThumbnail } from "@opencode/core/preview/thumbnail"
import { FileNotFoundError } from "@opencode/protocol/errors"
import { Project } from "@opencode/schema/project"
import { Effect } from "effect"
import { type HttpServerRequest, HttpServerResponse } from "effect/http"

// The image changes under the same address with every capture, so clients revalidate; the ETag makes that a 304.
const HEADERS = {
  "cache-control": "private, no-cache",
  "x-content-type-options": "nosniff",
  "content-security-policy": "default-src 'none'; sandbox",
}

/** `preview.thumbnails` and `preview.thumbnail` in the `server.experimental` group. */
export const makePreviewThumbnail = Effect.gen(function* () {
  const { db } = yield* Database.Service

  return {
    list: () =>
      PreviewThumbnail.list(db).pipe(
        Effect.map((rows) => ({ data: rows.map((row) => ({ ...row, projectID: Project.ID.make(row.projectID) })) })),
      ),
    get: (projectID: string, request: HttpServerRequest.HttpServerRequest) =>
      Effect.gen(function* () {
        const thumbnail = yield* PreviewThumbnail.read(db, projectID)
        const path = `/api/experimental/preview/thumbnail/${projectID}`

        if (!thumbnail) return yield* new FileNotFoundError({ path, message: `No preview thumbnail for ${projectID}` })
        const headers = { ...HEADERS, etag: `"${thumbnail.hash}"` }

        if (request.headers["if-none-match"]?.split(",").some((tag) => tag.trim().replace(/^w\//i, "") === headers.etag))
          return HttpServerResponse.empty({ status: 304, headers })

        return HttpServerResponse.uint8Array(thumbnail.data, { status: 200, contentType: "image/webp", headers })
      }),
  }
})
