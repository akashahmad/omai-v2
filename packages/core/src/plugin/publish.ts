export * as PublishPlugin from "./publish.js"

import { define } from "@opencode/plugin/effect/plugin"
import { Publish } from "@opencode/schema/publish"
import { Effect, Stream } from "effect"
import { PublishDomains } from "../publish/domains.js"
import { PublishService } from "../publish/service.js"

type Context<E> = {
  readonly error: (name: "publish.failed", message: string, data: { kind: Publish.FailureKind; message: string }) => E
}

export const Plugin = define({
  id: "omai.publish",
  effect: Effect.fn(function* (ctx) {
    const publish = yield* PublishService.Service
    const domains = yield* PublishDomains.Service
    const projectID = ctx.location.project.id
    const directory = ctx.location.directory
    const empty = () => ({})

    const publishRpc = yield* ctx.rpc
      .register(Publish.Definition, {
        status: () => publish.status(projectID, directory),
        available: (input, context) => publish.available(projectID, input.name).pipe(Effect.mapError(failure(context))),
        publish: (input, context) =>
          publish
            .publish({ projectID, directory, name: input.name, sessionID: input.sessionID })
            .pipe(Effect.mapError(failure(context))),
        cancel: () => publish.cancel(projectID).pipe(Effect.map(empty)),
        log: (input) => publish.log(projectID, input.id).pipe(Effect.map((text) => ({ text }))),
        remove: (input, context) =>
          publish.remove(projectID, input.confirm).pipe(Effect.map(empty), Effect.mapError(failure(context))),
      })
      .pipe(Effect.orDie)

    const domainsRpc = yield* ctx.rpc
      .register(Publish.DomainsDefinition, {
        list: () => domains.list(projectID),
        add: (input, context) =>
          domains.add(projectID, input.hostname, input.primary).pipe(Effect.mapError(failure(context))),
        remove: (input, context) => domains.remove(projectID, input.hostname).pipe(Effect.mapError(failure(context))),
        setPrimary: (input, context) =>
          domains.setPrimary(projectID, input.hostname).pipe(Effect.mapError(failure(context))),
        check: (input, context) => domains.check(projectID, input.hostname).pipe(Effect.mapError(failure(context))),
      })
      .pipe(Effect.orDie)

    yield* publish.changes(projectID, directory).pipe(
      Stream.runForEach((status) => publishRpc.events.emit("changed", status).pipe(Effect.ignore)),
      Effect.forkScoped({ startImmediately: true }),
    )
    yield* publish.logs(projectID).pipe(
      Stream.runForEach((line) => publishRpc.events.emit("log", line).pipe(Effect.ignore)),
      Effect.forkScoped({ startImmediately: true }),
    )
    yield* domains.changes(projectID).pipe(
      Stream.runForEach((next) => domainsRpc.events.emit("changed", next).pipe(Effect.ignore)),
      Effect.forkScoped({ startImmediately: true }),
    )
  }),
})

function failure<E>(context: Context<E>) {
  return (error: PublishService.PublishError) =>
    context.error("publish.failed", error.message, { kind: error.kind, message: error.message })
}
