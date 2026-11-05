import { $ } from "bun"
import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect, Layer, Stream } from "effect"
import { LanguageModel } from "@opencode/ai/effect"
import { OpenAIChat } from "@opencode/ai/protocols"
import { TestLLM } from "@opencode/ai/testing"
import { Agent } from "@opencode/core/agent"
import { Bus } from "@opencode/core/bus"
import { Checkpoints } from "@opencode/core/checkpoint/service"
import { CheckpointsPlugin } from "@opencode/core/plugin/checkpoints"
import { Rpc } from "@opencode/core/rpc"
import { Checkpoint } from "@opencode/schema/checkpoint"
import { Location } from "@opencode/core/location"
import { Project } from "@opencode/core/project"
import { Database } from "@opencode/core/database/database"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNodePlatform } from "@opencode/core/effect/app-node-platform"
import { Watcher } from "@opencode/core/filesystem/watcher"
import { LocationServiceMap } from "@opencode/core/location-service-map"
import { Model } from "@opencode/core/model"
import { Plugin } from "@opencode/core/plugin"
import { Provider } from "@opencode/core/provider"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { SessionEvent } from "@opencode/core/session/event"
import { SessionInbox } from "@opencode/core/session/inbox"
import { SessionMessage } from "@opencode/core/session/message"
import { SessionProjector } from "@opencode/core/session/projector"
import { SessionRunnerModel } from "@opencode/core/session/runner/model"
import { Snapshot } from "@opencode/core/snapshot"
import { Money } from "@opencode/schema/money"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Global } from "@opencode/util/global"
import { location } from "../fixture/location"
import { host } from "./host"
import { tempGlobalLayer } from "../fixture/global"
import { offlineModels } from "../fixture/models"
import { tmpdirScoped } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"

// Real execution: the scripted model answers, and a gate holds a session working for the busy test.
const llmLayer = TestLLM.testLayer({ fallback: TestLLM.text("Done", "done") })
const it = testEffect(
  Layer.merge(
    llmLayer,
    AppNodeBuilder.build(
      LayerNode.group([
        Database.node,
        Bus.node,
        SessionProjector.node,
        Session.node,
        LocationServiceMap.node,
        Checkpoints.node,
        Rpc.node,
      ]),
      [
        // Rpc needs a Location only for its own scope; the plugin gets its Location from the host below.
        Location.node.replace(
          Layer.succeed(
            Location.Service,
            Location.Service.of(location(Location.Ref.make({ directory: AbsolutePath.make("/workspace") }))),
          ),
        ),
        Bus.node.replace(Bus.configured({ persist: true })),
        Global.node.replace(tempGlobalLayer),
        offlineModels,
        Watcher.node.replace(Watcher.configured({ enabled: false })),
        LayerNodePlatform.llmClient.replace(llmLayer),
        SessionRunnerModel.node.replace(
          Layer.succeed(SessionRunnerModel.Service, {
            resolve: () =>
              Effect.succeed(
                SessionRunnerModel.resolved(
                  LanguageModel.make({ id: "test", provider: "test", route: OpenAIChat.route }),
                  {
                    capabilities: { tools: true, input: ["text"], output: ["text"] },
                    cost: [],
                    limit: { context: 200_000, output: 32_000 },
                  },
                ),
              ),
          }),
        ),
      ],
    ),
  ),
)

/** A real session in a project directory, served by the plugin through RPC. */
const served = Effect.fn(function* (options: { git: boolean }) {
  const tmp = yield* tmpdirScoped()
  const directory = path.join(tmp.path, "project")
  yield* Effect.promise(async () => {
    await fs.mkdir(directory)
    await fs.writeFile(path.join(directory, "a.txt"), "a\n")
    if (!options.git) return
    await $`git init -q`.cwd(directory).quiet()
    await $`git -c core.fsmonitor=false add .`.cwd(directory).quiet()
  })
  const sessions = yield* Session.Service
  const database = yield* Database.Service
  const bus = yield* Bus.Service
  const rpc = yield* Rpc.Service
  const created = yield* sessions.create({ location: { directory: AbsolutePath.make(directory) } })
  const location = LocationServiceMap.Service.get(created.location)
  yield* CheckpointsPlugin.Plugin.effect(
    host({
      location: new Location.Info({
        directory: created.location.directory,
        project: {
          id: Project.ID.global,
          directory: created.location.directory,
          canonical: created.location.directory,
        },
      }),
      rpc: Object.assign(rpc.client, { register: rpc.register }),
    }),
  )
  const client = rpc.client(Checkpoint.Definition)
  const changed: string[] = []
  yield* client.events.subscribe("changed").pipe(
    Stream.runForEach((event) => Effect.sync(() => void changed.push(event.data.sessionID))),
    Effect.forkScoped({ startImmediately: true }),
  )
  yield* Effect.yieldNow

  const request = Effect.fn(function* (
    text: string,
    edit: () => Promise<unknown>,
    outcome: "ended" | "failed" = "ended",
  ) {
    yield* sessions.prompt({ sessionID: created.id, text, resume: false })
    yield* SessionInbox.promote(database.db, bus, created.id, "steer")
    yield* Effect.gen(function* () {
      const plugins = yield* Plugin.Service
      yield* plugins.awaitActivation
      const snapshot = yield* Snapshot.Service
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
      const files = yield* snapshot.files({ from: before, to: after })
      if (outcome === "failed") {
        yield* bus.publish(SessionEvent.Step.Failed, {
          sessionID: created.id,
          assistantMessageID,
          error: { type: "provider.invalid-request", message: "Failed" },
          snapshot: after,
          files,
        })
        yield* bus.publish(SessionEvent.Execution.Failed, {
          sessionID: created.id,
          error: { type: "provider.invalid-request", message: "Failed" },
        })
        return
      }

      yield* bus.publish(SessionEvent.Step.Ended, {
        sessionID: created.id,
        assistantMessageID,
        finish: "stop",
        cost: Money.USD.zero,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        snapshot: after,
        files,
      })
      yield* bus.publish(SessionEvent.Execution.Succeeded, { sessionID: created.id })
    }).pipe(Effect.provide(location))
  })

  // Polls until `count` events have arrived, so tests do not depend on how fast delivery is.
  const eventually = (count: number) =>
    Effect.gen(function* () {
      while (changed.length < count) yield* Effect.sleep("10 millis")
    }).pipe(Effect.timeout("5 seconds"), Effect.orDie)
  const foreign = Effect.gen(function* () {
    const other = path.join(tmp.path, "other")
    yield* Effect.promise(() => fs.mkdir(other))
    return yield* sessions.create({ location: { directory: AbsolutePath.make(other) } })
  })
  return { client, created, changed, request, eventually, foreign, bus, directory, sessions }
})

const timeout = { timeout: 30_000 }

describe("omai.checkpoints plugin", () => {
  it.live(
    "list over RPC returns the tree",
    () =>
      Effect.gen(function* () {
        const chat = yield* served({ git: true })
        yield* chat.request("Request A", () => fs.writeFile(path.join(chat.directory, "a.txt"), "a edited\n"))
        yield* chat.request("Request B", () => fs.writeFile(path.join(chat.directory, "b.txt"), "b\n"))

        const listing = yield* chat.client.list({ sessionID: chat.created.id })
        expect(listing.available).toBe(true)
        expect(listing.nodes.map((node) => [node.title, node.path])).toEqual([
          ["Request A", "current"],
          ["Request B", "current"],
        ])
        expect(listing.current).toBe(listing.nodes[1]!.key)

        const change = yield* chat.client.diff({
          sessionID: chat.created.id,
          key: listing.nodes[1]!.key,
          mode: "change",
        })
        expect(change.files.map((file) => file.file)).toEqual(["b.txt"])

        const missing = yield* chat.client.jump({ sessionID: chat.created.id, key: "nope" }).pipe(Effect.flip)
        expect(missing).toMatchObject({ type: "checkpoint.missing" })
      }),
    timeout,
  )

  it.live(
    "list is unavailable without git",
    () =>
      Effect.gen(function* () {
        const chat = yield* served({ git: false })
        const listing = yield* chat.client.list({ sessionID: chat.created.id })
        expect(listing.available).toBe(false)
        expect(listing.nodes).toEqual([])
      }),
    timeout,
  )

  it.live(
    "rejects sessions from another Location and keeps their events out",
    () =>
      Effect.gen(function* () {
        const chat = yield* served({ git: true })
        const other = yield* chat.foreign

        expect(yield* chat.client.list({ sessionID: other.id }).pipe(Effect.flip)).toMatchObject({
          type: "checkpoint.missing",
        })
        expect(yield* chat.client.jump({ sessionID: other.id, key: "any" }).pipe(Effect.flip)).toMatchObject({
          type: "checkpoint.missing",
        })

        // Events arrive in order, so once the own session's event is seen, the other one's would have been too.
        yield* chat.bus.publish(SessionEvent.RevertEvent.Cleared, { sessionID: other.id })
        yield* chat.bus.publish(SessionEvent.RevertEvent.Cleared, { sessionID: chat.created.id })
        yield* chat.eventually(1)
        expect(chat.changed).toEqual([chat.created.id])
      }),
    timeout,
  )

  it.live(
    "changed fires after a request that changed files, after a jump, and after an undo",
    () =>
      Effect.gen(function* () {
        const chat = yield* served({ git: true })
        expect(chat.changed).toEqual([])

        yield* chat.request("Request A", () => fs.writeFile(path.join(chat.directory, "a.txt"), "a edited\n"))
        yield* chat.request("Request B", () => fs.writeFile(path.join(chat.directory, "b.txt"), "b\n"))
        yield* chat.eventually(2)
        expect(new Set(chat.changed)).toEqual(new Set([chat.created.id]))

        const listing = yield* chat.client.list({ sessionID: chat.created.id })
        const afterRequests = chat.changed.length
        yield* chat.client.jump({ sessionID: chat.created.id, key: listing.nodes[0]!.key })
        yield* chat.eventually(afterRequests + 1)

        const afterJump = chat.changed.length
        expect((yield* chat.client.undo({ sessionID: chat.created.id })).done).toBe(true)
        yield* chat.eventually(afterJump + 1)
        expect((yield* chat.client.list({ sessionID: chat.created.id })).current).toBe(listing.current)
      }),
    timeout,
  )

  it.live(
    "changed fires after a failed step that changed files",
    () =>
      Effect.gen(function* () {
        const chat = yield* served({ git: true })
        yield* chat.request("Request A", () => fs.writeFile(path.join(chat.directory, "a.txt"), "a edited\n"), "failed")
        yield* chat.eventually(1)
        expect(chat.changed).toEqual([chat.created.id])
        const listing = yield* chat.client.list({ sessionID: chat.created.id })
        expect(listing.nodes.map((node) => node.title)).toEqual(["Request A"])
      }),
    timeout,
  )

  it.live(
    "jump and undo are refused while messages are queued",
    () =>
      Effect.gen(function* () {
        const chat = yield* served({ git: true })
        yield* chat.request("Request A", () => fs.writeFile(path.join(chat.directory, "a.txt"), "a edited\n"))
        yield* chat.request("Request B", () => fs.writeFile(path.join(chat.directory, "b.txt"), "b\n"))
        const listing = yield* chat.client.list({ sessionID: chat.created.id })
        yield* chat.client.jump({ sessionID: chat.created.id, key: listing.nodes[0]!.key })

        // Sent without starting work, so it waits in the queue.
        yield* chat.sessions.synthetic({ sessionID: chat.created.id, text: "Later", delivery: "queue", resume: false })
        expect(
          yield* chat.client.jump({ sessionID: chat.created.id, key: listing.nodes[1]!.key }).pipe(Effect.flip),
        ).toMatchObject({ type: "checkpoint.queued", message: "Wait for queued messages to be delivered" })
        expect(yield* chat.client.undo({ sessionID: chat.created.id }).pipe(Effect.flip)).toMatchObject({
          type: "checkpoint.queued",
        })
        expect((yield* chat.client.list({ sessionID: chat.created.id })).current).toBe(listing.nodes[0]!.key)
      }),
    timeout,
  )
})
