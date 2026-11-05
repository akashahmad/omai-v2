export * as GitToolPlugin from "./git-tool.js"

import { define } from "@opencode/plugin/effect/plugin"
import { GitTool } from "@opencode/schema/git-tool"
import { Effect } from "effect"
import { abort, branchCreate, branchSwitch, commit, continueOperation, fetch, init, log, pull, push, remoteAdd, remoteRemove, remoteSet, setProfile, show } from "../git-tool/actions.js"
import { discard, fileDiff, GitError, readStatus, stage } from "../git-tool/status.js"

type Context<E> = { readonly error: (name: "git.failed", message: string, data: { kind: GitTool.FailureKind; message: string; details: string }) => E }

export const Plugin = define({
  id: "omai.git",
  effect: Effect.fn(function* (ctx) {
    const cwd = ctx.location.directory
    const empty = () => ({})
    // The events need the registration, which needs the handlers that publish them.
    const published: { emit?: (status: GitTool.Status) => Effect.Effect<void, unknown> } = {}

    const read = <A, E>(run: () => Promise<A>, context: Context<E>) =>
      Effect.tryPromise({ try: run, catch: (error) => failure(error, context) })

    // A method that can touch the repository ends by publishing the new status, so open windows refresh without polling.
    const change = <A, E>(run: () => Promise<A>, context: Context<E>) =>
      read(run, context).pipe(
        Effect.tap(() =>
          Effect.tryPromise(() => readStatus(cwd)).pipe(
            Effect.flatMap((next) => published.emit?.(next) ?? Effect.void),
            Effect.catchCause(() => Effect.void),
          ),
        ),
      )

    const rpc = yield* ctx.rpc
      .register(GitTool.Definition, {
        status: (_input, context) => read(() => readStatus(cwd), context),
        diff: (input, context) => read(() => fileDiff(cwd, input), context),
        stage: (input, context) => change(() => stage(cwd, [...input.paths], input.staged).then(empty), context),
        discard: (input, context) => change(() => discard(cwd, [...input.paths]).then(empty), context),
        commit: (input, context) => change(() => commit(cwd, input), context),
        profile: (input, context) => change(() => setProfile(cwd, input).then(empty), context),
        push: (input, context) => change(() => push(cwd, input), context),
        pull: (input, context) => change(() => pull(cwd, input), context),
        fetch: (_input, context) => change(() => fetch(cwd), context),
        abort: (_input, context) => change(() => abort(cwd), context),
        continue: (_input, context) => change(() => continueOperation(cwd), context),
        remoteAdd: (input, context) => change(() => remoteAdd(cwd, input).then(empty), context),
        remoteSet: (input, context) => change(() => remoteSet(cwd, input).then(empty), context),
        remoteRemove: (input, context) => change(() => remoteRemove(cwd, input.name).then(empty), context),
        branchCreate: (input, context) => change(() => branchCreate(cwd, input.name).then(empty), context),
        branchSwitch: (input, context) => change(() => branchSwitch(cwd, input.name).then(empty), context),
        log: (input, context) => read(() => log(cwd, input), context),
        show: (input, context) => read(() => show(cwd, input.hash), context),
        init: (_input, context) => change(() => init(cwd).then(empty), context),
      })
      .pipe(Effect.orDie)
    published.emit = (status) => rpc.events.emit("changed", status)
  }),
})

function failure<E>(error: unknown, context: Context<E>) {
  if (error instanceof GitError) return context.error("git.failed", error.message, { kind: error.kind, message: error.message, details: error.details })
  const message = error instanceof Error ? error.message : "Git failed."

  return context.error("git.failed", message, { kind: "other", message, details: "" })
}
