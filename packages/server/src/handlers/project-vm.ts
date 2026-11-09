import { mkdir, mkdtemp, open, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { PersistentPty } from "@opencode/core/persistent-pty"
import { ProjectVm } from "@opencode/core/project-vm/project-vm"
import { ProjectVmBusy } from "@opencode/core/project-vm/busy"
import { SessionExecution } from "@opencode/core/session/execution"
import { ConflictError, FileNotFoundError, InvalidRequestError } from "@opencode/protocol/errors"
import { Effect, Stream } from "effect"
import { type HttpServerRequest, HttpServerResponse } from "effect/http"

const UPLOAD_LIMIT = 500 * 1024 * 1024
const UNPACKED_LIMIT = 2 * 1024 * 1024 * 1024


/** The `projectVm.*` endpoints in the `server.experimental` group. Only a MicroVM serves them. */
export const makeProjectVm = Effect.gen(function* () {
  const execution = yield* SessionExecution.Service
  const pty = yield* PersistentPty.Service
  const vm = Effect.suspend(() => {
    const slug = process.env.OMAI_PROJECT_SLUG
    const home = process.env.OMAI_PROJECTS_HOME
    if (!slug || !home)
      return Effect.fail(new FileNotFoundError({ path: "/api/experimental/project-vm", message: "Not a project VM" }))
    return Effect.succeed({ slug, home })
  })

  return {
    busy: () =>
      vm.pipe(
        Effect.andThen(ProjectVmBusy.current),
        Effect.provideService(SessionExecution.Service, execution),
        Effect.provideService(PersistentPty.Service, pty),
      ),

    init: () => vm.pipe(Effect.flatMap((input) => Effect.promise(() => ProjectVm.init(input)))),

    upload: (request: HttpServerRequest.HttpServerRequest) =>
      Effect.gen(function* () {
        const input = yield* vm
        if (yield* Effect.promise(() => ProjectVm.initialized(input)))
          return yield* new ConflictError({ message: "The project is already initialised", resource: "project" })
        const directory = path.join(input.home, input.slug)
        const temp = yield* Effect.promise(() => mkdtemp(path.join(tmpdir(), "omai-upload-")))
        const zip = path.join(temp, "upload.zip")
        // Streamed to a temporary file, never held in memory, then unpacked.
        // A big zip over a slow line takes minutes; the VM must not pause under it.
        const release = ProjectVmBusy.hold("upload")
        const result = yield* Effect.gen(function* () {
          const file = yield* Effect.promise(() => open(zip, "w"))
          const bytes = yield* request.stream.pipe(
            Stream.runFoldEffect(
              () => 0,
              (total, chunk) =>
                total + chunk.length > UPLOAD_LIMIT
                  ? Effect.succeed(Number.POSITIVE_INFINITY)
                  : Effect.promise(() => file.write(chunk)).pipe(Effect.as(total + chunk.length)),
            ),
            Effect.ensuring(Effect.promise(() => file.close())),
            Effect.orDie,
          )
          if (bytes === Number.POSITIVE_INFINITY) return new ProjectVm.UnzipError(`The zip is larger than ${UPLOAD_LIMIT} bytes`)
          yield* Effect.promise(() => mkdir(directory, { recursive: true }))
          return yield* Effect.promise(() =>
            ProjectVm.unzip({ zip, directory, maxBytes: UNPACKED_LIMIT }).catch((error: unknown) => {
              if (error instanceof ProjectVm.UnzipError) return error
              throw error
            }),
          )
        }).pipe(
          Effect.ensuring(Effect.sync(release)),
          Effect.ensuring(Effect.promise(() => rm(temp, { recursive: true, force: true }))),
        )
        if (result instanceof Error) return yield* new InvalidRequestError({ message: result.message, kind: "zip" })
        return HttpServerResponse.jsonUnsafe(result)
      }),
  }
})
