export * as CheckpointsPlugin from "./checkpoints.js"

import { define } from "@opencode/plugin/effect/plugin"
import { Checkpoint } from "@opencode/schema/checkpoint"
import { Session as SessionID } from "@opencode/schema/session"
import type { RpcCallContext } from "@opencode/plugin/effect/rpc"
import { Effect, Stream } from "effect"
import { Bus } from "../bus.js"
import { Checkpoints } from "../checkpoint/service.js"
import { Session } from "../session.js"
import { BusyError, NotFoundError } from "../session/error.js"
import { SessionEvent } from "../session/event.js"

export const Plugin = define({
  id: "omai.checkpoints",
  effect: Effect.fn(function* (ctx) {
    const checkpoints = yield* Checkpoints.Service
    const sessions = yield* Session.Service
    const bus = yield* Bus.Service
    // The events need the registration, which needs the handlers that publish them.
    const published: { emit?: (sessionID: SessionID.ID) => Effect.Effect<void, unknown> } = {}
    const announce = (sessionID: SessionID.ID) => published.emit?.(sessionID) ?? Effect.void

    // The services are global, so every method first checks the session lives in this plugin's Location.
    const owns = (session: Session.Info) =>
      session.location.directory === ctx.location.directory && session.location.workspaceID === ctx.location.workspaceID

    const guarded = <A>(
      context: RpcCallContext<typeof Checkpoint.Definition.methods.list>,
      sessionID: SessionID.ID,
      effect: Effect.Effect<A, BusyError | NotFoundError | Checkpoints.MissingError | Checkpoints.QueuedError>,
    ) =>
      sessions.get(sessionID).pipe(
        Effect.filterOrFail(owns, () => new NotFoundError({ sessionID })),
        Effect.andThen(effect),
        Effect.catchTags({
          "Session.NotFoundError": (error) =>
            Effect.fail(context.error("checkpoint.missing", `Session ${error.sessionID} not found`, {})),
          "Checkpoint.MissingError": () => Effect.fail(context.error("checkpoint.missing", "Checkpoint not found", {})),
          "Checkpoint.QueuedError": () =>
            Effect.fail(context.error("checkpoint.queued", "Wait for queued messages to be delivered", {})),
          "Session.BusyError": (error) =>
            Effect.fail(
              context.error("checkpoint.busy", `Session ${error.sessionID} is busy`, { session: error.sessionID }),
            ),
        }),
      )

    const rpc = yield* ctx.rpc
      .register(Checkpoint.Definition, {
        list: (input, context) => guarded(context, input.sessionID, checkpoints.list(input.sessionID)),
        diff: (input, context) =>
          guarded(
            context,
            input.sessionID,
            checkpoints.diff(input.sessionID, input.key, input.mode).pipe(Effect.map((files) => ({ files }))),
          ),
        jump: (input, context) =>
          guarded(
            context,
            input.sessionID,
            checkpoints.jump(input.sessionID, input.key).pipe(
              Effect.tap(() => announce(input.sessionID).pipe(Effect.ignore)),
              Effect.as({}),
            ),
          ),
        undo: (input, context) =>
          guarded(
            context,
            input.sessionID,
            checkpoints.undo(input.sessionID).pipe(
              Effect.tap((done) => (done ? announce(input.sessionID).pipe(Effect.ignore) : Effect.void)),
              Effect.map((done) => ({ done })),
            ),
          ),
      })
      .pipe(Effect.orDie)
    published.emit = (sessionID) => rpc.events.emit("changed", { sessionID })

    // A step that changed files adds a checkpoint, even one that failed; revert and path events change which ones are
    // visible.
    yield* bus
      .subscribe([
        SessionEvent.Step.Ended,
        SessionEvent.Step.Failed,
        SessionEvent.RevertEvent.Staged,
        SessionEvent.RevertEvent.Cleared,
        SessionEvent.RevertEvent.Committed,
        SessionEvent.PathSwapped,
      ])
      .pipe(
        Stream.filter(
          (event) =>
            (event.type !== SessionEvent.Step.Ended.type && event.type !== SessionEvent.Step.Failed.type) ||
            (event.data.files?.length ?? 0) > 0,
        ),
        Stream.runForEach((event) =>
          sessions.get(event.data.sessionID).pipe(
            Effect.flatMap((session) => (owns(session) ? announce(session.id) : Effect.void)),
            Effect.ignore,
          ),
        ),
        Effect.forkScoped({ startImmediately: true }),
      )
  }),
})
