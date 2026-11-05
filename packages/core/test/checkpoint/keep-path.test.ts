import { $ } from "bun"
import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect } from "effect"
import { Agent } from "@opencode/core/agent"
import { Bus } from "@opencode/core/bus"
import { CheckpointBranch } from "@opencode/core/checkpoint/branch"
import { deriveCheckpoints } from "@opencode/core/checkpoint/derive"
import { Database } from "@opencode/core/database/database"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LocationServiceMap } from "@opencode/core/location-service-map"
import { Model } from "@opencode/core/model"
import { Plugin } from "@opencode/core/plugin"
import { Provider } from "@opencode/core/provider"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { SessionEvent } from "@opencode/core/session/event"
import { SessionExecution } from "@opencode/core/session/execution"
import { SessionInbox } from "@opencode/core/session/inbox"
import { SessionMessage } from "@opencode/core/session/message"
import { SessionProjector } from "@opencode/core/session/projector"
import { Snapshot } from "@opencode/core/snapshot"
import { Money } from "@opencode/schema/money"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Global } from "@opencode/util/global"
import { tempGlobalLayer } from "../fixture/global"
import { offlineModels } from "../fixture/models"
import { tmpdirScoped } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, Bus.node, SessionProjector.node, Session.node, LocationServiceMap.node]),
    [
      Bus.node.replace(Bus.configured({ persist: true })),
      Global.node.replace(tempGlobalLayer),
      SessionExecution.node.replace(SessionExecution.noopLayer),
      offlineModels,
    ],
  ),
)

const requests = (messages: readonly SessionMessage.Info[]) =>
  messages.flatMap((message) => (message.type === "user" ? [message.text] : []))

// Every way a staged revert gets committed keeps the abandoned path.
const continuations = [
  { kind: "prompt", name: "a new prompt", visible: ["Request A", "Request C"] },
  { kind: "compact", name: "compacting", visible: ["Request A"] },
  { kind: "commit", name: "an explicit commit", visible: ["Request A"] },
] as const

describe("keeping the abandoned path", () => {
  continuations.forEach((continuation) =>
    it.live(
      `going back and continuing with ${continuation.name} keeps the abandoned path as a branch`,
      () =>
        Effect.gen(function* () {
          const tmp = yield* tmpdirScoped()
          const directory = path.join(tmp.path, "project")
          const write = (name: string, content: string) => () => fs.writeFile(path.join(directory, name), content)
          yield* Effect.promise(async () => {
            await fs.mkdir(directory)
            await write("a.txt", "a\n")()
            await $`git init -q`.cwd(directory).quiet()
            await $`git -c core.fsmonitor=false add .`.cwd(directory).quiet()
          })
          const sessions = yield* Session.Service
          const database = yield* Database.Service
          const bus = yield* Bus.Service
          const created = yield* sessions.create({ location: { directory: AbsolutePath.make(directory) } })

          yield* Effect.gen(function* () {
            const plugins = yield* Plugin.Service
            yield* plugins.awaitActivation
            const snapshot = yield* Snapshot.Service
            const prompt = Effect.fn(function* (text: string) {
              const admitted = yield* sessions.prompt({ sessionID: created.id, text, resume: false })
              yield* SessionInbox.promote(database.db, bus, created.id, "steer")
              return admitted.id
            })
            const step = Effect.fn(function* (edit: () => Promise<unknown>) {
              const before = yield* snapshot.capture()
              if (!before) throw new Error("Start snapshot missing")
              const assistantMessageID = SessionMessage.ID.create()
              yield* bus.publish(SessionEvent.Step.Started, {
                sessionID: created.id,
                assistantMessageID,
                agent: Agent.defaultID,
                model: { id: Model.ID.make("test-model"), providerID: Provider.ID.make("test-provider") },
                snapshot: before,
                started: 0,
              })
              yield* Effect.promise(edit)
              const after = yield* snapshot.capture()
              if (!after) throw new Error("End snapshot missing")
              yield* bus.publish(SessionEvent.Step.Ended, {
                sessionID: created.id,
                assistantMessageID,
                finish: "stop",
                cost: Money.USD.zero,
                tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
                snapshot: after,
                files: yield* snapshot.files({ from: before, to: after }),
              })
              yield* bus.publish(SessionEvent.Execution.Succeeded, { sessionID: created.id })
            })

            yield* prompt("Request A")
            yield* step(write("a.txt", "a edited\n"))
            const b = yield* prompt("Request B")
            yield* step(write("b.txt", "b\n"))
            const original = deriveCheckpoints(yield* sessions.messages({ sessionID: created.id, order: "asc" }))
            expect(original.map((checkpoint) => checkpoint.title)).toEqual(["Request A", "Request B"])

            // A commit with nothing staged keeps nothing.
            yield* sessions.revert.commit(created.id)
            expect(yield* CheckpointBranch.forRoot(database.db, created.id)).toEqual([])

            yield* sessions.revert.stage({ sessionID: created.id, messageID: b })
            if (continuation.kind === "prompt") yield* prompt("Request C")
            if (continuation.kind === "compact") yield* sessions.compact({ sessionID: created.id })
            if (continuation.kind === "commit") yield* sessions.revert.commit(created.id)

            expect((yield* sessions.get(created.id)).revert).toBeUndefined()
            expect(requests(yield* sessions.messages({ sessionID: created.id, order: "asc" }))).toEqual([
              ...continuation.visible,
            ])
            const branches = yield* CheckpointBranch.forRoot(database.db, created.id)
            expect(branches).toHaveLength(1)
            const branch = branches[0]!
            expect(branch.parent_session_id).toBe(created.id)
            expect(branch.boundary_key).toBe(original[0]!.key)
            expect(branch.revert_message_id).toBeNull()
            const kept = yield* sessions.messages({ sessionID: branch.session_id, order: "asc" })
            expect(requests(kept)).toEqual(["Request A", "Request B"])
            expect(deriveCheckpoints(kept).map((checkpoint) => checkpoint.key)).toEqual(
              original.map((checkpoint) => checkpoint.key),
            )
            expect((yield* sessions.list()).data.map((session) => session.id)).toEqual([created.id])
          }).pipe(Effect.provide(LocationServiceMap.Service.get(created.location)))
        }),
      // Real Location/plugin startup and Git snapshots can exceed five seconds under CI load.
      { timeout: 30_000 },
    ),
  )
})
