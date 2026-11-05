import { $ } from "bun"
import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { eq } from "drizzle-orm"
import { Deferred, Effect, Fiber, Layer, Stream } from "effect"
import { LanguageModel } from "@opencode/ai/effect"
import { OpenAIChat } from "@opencode/ai/protocols"
import { TestLLM } from "@opencode/ai/testing"
import { Agent } from "@opencode/core/agent"
import { Bus } from "@opencode/core/bus"
import { CheckpointBranch } from "@opencode/core/checkpoint/branch"
import { Checkpoints } from "@opencode/core/checkpoint/service"
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
import { SessionTable } from "@opencode/core/session/sql"
import { SessionRunnerModel } from "@opencode/core/session/runner/model"
import { Snapshot } from "@opencode/core/snapshot"
import { Money } from "@opencode/schema/money"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Global } from "@opencode/util/global"
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
      ]),
      [
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

const requests = (messages: readonly SessionMessage.Info[]) =>
  messages.flatMap((message) => (message.type === "user" ? [message.text] : []))

/** A real session in a git project, with helpers that record a request and the files its step changed. */
const conversation = Effect.fn(function* () {
  const tmp = yield* tmpdirScoped()
  const directory = path.join(tmp.path, "project")
  yield* Effect.promise(async () => {
    await fs.mkdir(directory)
    await fs.writeFile(path.join(directory, "a.txt"), "a\n")
    await $`git init -q`.cwd(directory).quiet()
    await $`git -c core.fsmonitor=false add .`.cwd(directory).quiet()
  })
  const sessions = yield* Session.Service
  const database = yield* Database.Service
  const bus = yield* Bus.Service
  const created = yield* sessions.create({ location: { directory: AbsolutePath.make(directory) } })
  const location = LocationServiceMap.Service.get(created.location)
  const write = (name: string, content: string) => () => fs.writeFile(path.join(directory, name), content)
  const read = (name: string) =>
    Effect.promise(() => fs.readFile(path.join(directory, name), "utf8").catch(() => undefined))

  const request = Effect.fn(function* (text: string, edit: () => Promise<unknown>) {
    const admitted = yield* sessions.prompt({ sessionID: created.id, text, resume: false })
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
    }).pipe(Effect.provide(location))
    return admitted.id
  })

  const visible = Effect.fn(function* () {
    const session = yield* sessions.get(created.id)
    const messages = yield* sessions.messages({ sessionID: created.id, order: "asc" })
    const boundary = session.revert ? messages.findIndex((message) => message.id === session.revert?.messageID) : -1
    return requests(boundary < 0 ? messages : messages.slice(0, boundary))
  })

  const keys = Effect.fn(function* () {
    const checkpoints = yield* Checkpoints.Service
    const listed = yield* checkpoints.list(created.id)
    return Object.fromEntries(listed.nodes.map((node) => [node.title, node]))
  })

  /** Every checkpoint on every path, each listed once, and the files a jump must have put back. */
  const expectAt = Effect.fn(function* (input: {
    titles: string[]
    visible: string[]
    files: Record<string, string | undefined>
  }) {
    const checkpoints = yield* Checkpoints.Service
    const listed = yield* checkpoints.list(created.id)
    expect(listed.nodes.map((node) => node.title).toSorted()).toEqual(input.titles.toSorted())
    expect(yield* visible()).toEqual(input.visible)
    expect(listed.nodes.find((node) => node.key === listed.current)?.title).toBe(input.visible.at(-1))
    yield* Effect.forEach(Object.entries(input.files), ([name, content]) =>
      read(name).pipe(Effect.map((found) => expect([name, found]).toEqual([name, content]))),
    )
  })

  return { sessions, database, created, write, read, request, visible, keys, expectAt }
})

const timeout = { timeout: 30_000 }

describe("checkpoints", () => {
  it.live(
    "list marks the current checkpoint after going back",
    () =>
      Effect.gen(function* () {
        const checkpoints = yield* Checkpoints.Service
        const chat = yield* conversation()
        yield* chat.request("Request A", chat.write("a.txt", "a edited\n"))
        const b = yield* chat.request("Request B", chat.write("b.txt", "b\n"))

        const tip = yield* checkpoints.list(chat.created.id)
        expect(tip.available).toBe(true)
        expect(tip.nodes.map((node) => [node.title, node.path])).toEqual([
          ["Request A", "current"],
          ["Request B", "current"],
        ])
        expect(tip.current).toBe(tip.nodes[1]!.key)

        yield* chat.sessions.revert.stage({ sessionID: chat.created.id, messageID: b })
        const back = yield* checkpoints.list(chat.created.id)
        expect(back.nodes.map((node) => [node.title, node.path])).toEqual([
          ["Request A", "current"],
          ["Request B", "ahead"],
        ])
        expect(back.current).toBe(back.nodes[0]!.key)
      }),
    timeout,
  )

  it.live(
    "jump to an ahead checkpoint restores files and messages",
    () =>
      Effect.gen(function* () {
        const checkpoints = yield* Checkpoints.Service
        const chat = yield* conversation()
        yield* chat.request("Request A", chat.write("a.txt", "a edited\n"))
        const b = yield* chat.request("Request B", chat.write("b.txt", "b\n"))
        const nodes = yield* chat.keys()
        // A later hand edit to a file the conversation changed is put back to the checkpoint too.
        yield* Effect.promise(chat.write("a.txt", "a edited by hand\n"))

        yield* checkpoints.jump(chat.created.id, nodes["Request A"]!.key)
        expect(yield* chat.visible()).toEqual(["Request A"])
        expect((yield* chat.sessions.get(chat.created.id)).revert?.messageID).toBe(b)
        expect(yield* chat.read("a.txt")).toBe("a edited\n")
        expect(yield* chat.read("b.txt")).toBeUndefined()
        expect((yield* checkpoints.list(chat.created.id)).current).toBe(nodes["Request A"]!.key)

        yield* checkpoints.jump(chat.created.id, nodes["Request B"]!.key)
        expect(yield* chat.visible()).toEqual(["Request A", "Request B"])
        expect((yield* chat.sessions.get(chat.created.id)).revert).toBeUndefined()
        expect(yield* chat.read("b.txt")).toBe("b\n")
        expect((yield* checkpoints.list(chat.created.id)).current).toBe(nodes["Request B"]!.key)
      }),
    timeout,
  )

  it.live(
    "jump across branches swaps the conversation and keeps the old path",
    () =>
      Effect.gen(function* () {
        const checkpoints = yield* Checkpoints.Service
        const chat = yield* conversation()
        yield* chat.request("Request A", chat.write("a.txt", "a edited\n"))
        yield* chat.request("Request B", chat.write("b.txt", "b\n"))
        const before = yield* chat.keys()
        yield* checkpoints.jump(chat.created.id, before["Request A"]!.key)
        yield* chat.request("Request C", chat.write("c.txt", "c\n"))
        const [kept] = yield* CheckpointBranch.forRoot(chat.database.db, chat.created.id)
        const keptIDs = (yield* chat.sessions.messages({ sessionID: kept!.session_id, order: "asc" }))
          .filter((message) => message.type !== "idle")
          .map((message) => message.id)

        const tree = yield* chat.keys()
        expect(tree["Request C"]!.path).toBe("current")
        expect(tree["Request B"]!.path).toBe("branch")
        expect(tree["Request B"]!.branchID).toBe(kept!.session_id)
        expect(tree["Request B"]!.parentKey).toBe(before["Request A"]!.key)

        // The change summary describes the history, so it moves with it.
        const summary = (sessionID: typeof chat.created.id) =>
          chat.database.db
            .select({ additions: SessionTable.summary_additions, files: SessionTable.summary_files })
            .from(SessionTable)
            .where(eq(SessionTable.id, sessionID))
            .get()
            .pipe(Effect.orDie)
        yield* chat.database.db
          .update(SessionTable)
          .set({ summary_additions: 3, summary_files: 2 })
          .where(eq(SessionTable.id, chat.created.id))
          .run()
          .pipe(Effect.orDie)

        yield* checkpoints.jump(chat.created.id, before["Request B"]!.key)
        expect(yield* chat.visible()).toEqual(["Request A", "Request B"])
        expect(yield* summary(kept!.session_id)).toEqual({ additions: 3, files: 2 })
        expect(yield* summary(chat.created.id)).toEqual({ additions: null, files: null })
        // The path moved over with its message ids intact; the redo's wake may add an idle marker after it.
        expect(
          (yield* chat.sessions.messages({ sessionID: chat.created.id, order: "asc" }))
            .filter((message) => message.type !== "idle")
            .map((message) => message.id),
        ).toEqual(keptIDs)
        expect(yield* chat.read("a.txt")).toBe("a edited\n")
        expect(yield* chat.read("b.txt")).toBe("b\n")
        expect(yield* chat.read("c.txt")).toBeUndefined()

        const branches = yield* CheckpointBranch.forRoot(chat.database.db, chat.created.id)
        expect(branches).toHaveLength(1)
        expect(requests(yield* chat.sessions.messages({ sessionID: branches[0]!.session_id, order: "asc" }))).toEqual([
          "Request A",
          "Request C",
        ])
        expect((yield* chat.sessions.list()).data.map((session) => session.id)).toEqual([chat.created.id])

        const after = yield* checkpoints.list(chat.created.id)
        expect(after.current).toBe(before["Request B"]!.key)
        expect(after.nodes.map((node) => [node.title, node.path])).toEqual([
          ["Request A", "current"],
          ["Request B", "current"],
          ["Request C", "branch"],
        ])

        // A new request on the swapped-in path keeps working.
        yield* chat.request("Request D", chat.write("d.txt", "d\n"))
        expect(yield* chat.visible()).toEqual(["Request A", "Request B", "Request D"])
      }),
    timeout,
  )

  it.live(
    "a jump to the newest checkpoint wakes the session only after the files are restored",
    () =>
      Effect.gen(function* () {
        const checkpoints = yield* Checkpoints.Service
        const bus = yield* Bus.Service
        const chat = yield* conversation()
        yield* chat.request("Request A", chat.write("a.txt", "a edited\n"))
        yield* chat.request("Request B", chat.write("b.txt", "b\n"))
        const nodes = yield* chat.keys()
        yield* checkpoints.jump(chat.created.id, nodes["Request A"]!.key)
        // Clearing the revert leaves this hand edit alone; only the final restore puts a.txt back.
        yield* Effect.promise(chat.write("a.txt", "a edited by hand\n"))

        // Whatever the wake starts sees the files as they are when it starts.
        const seen = yield* Deferred.make<string | undefined>()
        yield* bus.subscribe([SessionEvent.Execution.Started]).pipe(
          Stream.filter((event) => event.data.sessionID === chat.created.id),
          Stream.take(1),
          Stream.runForEach(() => chat.read("a.txt").pipe(Effect.flatMap((found) => Deferred.succeed(seen, found)))),
          Effect.forkScoped({ startImmediately: true }),
        )
        yield* checkpoints.jump(chat.created.id, nodes["Request B"]!.key)
        expect(yield* Deferred.await(seen)).toBe("a edited\n")
        expect(yield* chat.read("a.txt")).toBe("a edited\n")
      }),
    timeout,
  )

  it.live(
    "jump leaves files this conversation never touched alone",
    () =>
      Effect.gen(function* () {
        const checkpoints = yield* Checkpoints.Service
        const chat = yield* conversation()
        yield* chat.request("Request A", chat.write("a.txt", "a edited\n"))
        yield* chat.request("Request B", chat.write("b.txt", "b\n"))
        yield* Effect.promise(chat.write("other.txt", "someone else\n"))

        yield* checkpoints.jump(chat.created.id, (yield* chat.keys())["Request A"]!.key)
        expect(yield* chat.read("other.txt")).toBe("someone else\n")
        expect(yield* chat.read("b.txt")).toBeUndefined()
      }),
    timeout,
  )

  it.live(
    "jump is refused while any session in the project is working",
    () =>
      Effect.gen(function* () {
        const checkpoints = yield* Checkpoints.Service
        const llm = yield* TestLLM.Test
        const chat = yield* conversation()
        yield* chat.request("Request A", chat.write("a.txt", "a edited\n"))
        yield* chat.request("Request B", chat.write("b.txt", "b\n"))
        const nodes = yield* chat.keys()

        // Another conversation in the same project, held mid-request by the model.
        const other = yield* chat.sessions.create({
          location: chat.created.location,
          model: Model.Ref.make({ id: Model.ID.make("test"), providerID: Provider.ID.make("test") }),
        })
        const gate = yield* llm.gate()
        yield* chat.sessions.prompt({ sessionID: other.id, text: "Keep working" })
        yield* gate.started
        expect(Array.from(yield* chat.sessions.active)).toEqual([other.id])

        const refused = yield* checkpoints.jump(chat.created.id, nodes["Request A"]!.key).pipe(Effect.flip)
        expect(refused._tag).toBe("Session.BusyError")
        expect(refused._tag === "Session.BusyError" && refused.sessionID).toBe(other.id)
        expect(yield* chat.read("b.txt")).toBe("b\n")
        expect(yield* chat.visible()).toEqual(["Request A", "Request B"])

        yield* gate.release
        yield* chat.sessions.wait(other.id)
        yield* checkpoints.jump(chat.created.id, nodes["Request A"]!.key)
        expect(yield* chat.visible()).toEqual(["Request A"])
      }),
    timeout,
  )

  it.live(
    "undo returns to the state before the jump",
    () =>
      Effect.gen(function* () {
        const checkpoints = yield* Checkpoints.Service
        const chat = yield* conversation()
        yield* chat.request("Request A", chat.write("a.txt", "a edited\n"))
        yield* chat.request("Request B", chat.write("b.txt", "b\n"))
        const nodes = yield* chat.keys()

        // On the current path.
        yield* checkpoints.jump(chat.created.id, nodes["Request A"]!.key)
        expect(yield* checkpoints.undo(chat.created.id)).toBe(true)
        expect(yield* chat.visible()).toEqual(["Request A", "Request B"])
        expect((yield* chat.sessions.get(chat.created.id)).revert).toBeUndefined()
        expect(yield* chat.read("b.txt")).toBe("b\n")
        expect((yield* checkpoints.list(chat.created.id)).current).toBe(nodes["Request B"]!.key)

        // Across paths.
        yield* checkpoints.jump(chat.created.id, nodes["Request A"]!.key)
        yield* chat.request("Request C", chat.write("c.txt", "c\n"))
        yield* Effect.promise(chat.write("c.txt", "c edited by hand\n"))
        yield* checkpoints.jump(chat.created.id, nodes["Request B"]!.key)
        // A jump to a path's newest checkpoint wakes the session; undo waits for it like any other work.
        yield* chat.sessions.wait(chat.created.id)
        expect(yield* checkpoints.undo(chat.created.id)).toBe(true)
        expect(yield* chat.visible()).toEqual(["Request A", "Request C"])
        expect(yield* chat.read("c.txt")).toBe("c edited by hand\n")
        expect(yield* chat.read("b.txt")).toBeUndefined()
        const branches = yield* CheckpointBranch.forRoot(chat.database.db, chat.created.id)
        expect(branches).toHaveLength(1)
        expect(requests(yield* chat.sessions.messages({ sessionID: branches[0]!.session_id, order: "asc" }))).toEqual([
          "Request A",
          "Request B",
        ])

        // Nothing left to undo.
        expect(yield* checkpoints.undo(chat.created.id)).toBe(false)
        expect(yield* chat.visible()).toEqual(["Request A", "Request C"])

        // A jump stops being undoable once the conversation moves on.
        yield* checkpoints.jump(chat.created.id, nodes["Request A"]!.key)
        yield* chat.request("Request D", chat.write("d.txt", "d\n"))
        expect(yield* checkpoints.undo(chat.created.id)).toBe(false)
        expect(yield* chat.visible()).toEqual(["Request A", "Request D"])
      }),
    timeout,
  )

  it.live(
    "a second round trip keeps every checkpoint reachable",
    () =>
      Effect.gen(function* () {
        const checkpoints = yield* Checkpoints.Service
        const chat = yield* conversation()
        yield* chat.request("Request A", chat.write("a.txt", "a edited\n"))
        yield* chat.request("Request B", chat.write("b.txt", "b\n"))
        yield* checkpoints.jump(chat.created.id, (yield* chat.keys())["Request A"]!.key)
        yield* chat.request("Request C", chat.write("c.txt", "c\n"))
        const nodes = yield* chat.keys()
        const titles = ["Request A", "Request B", "Request C"]
        const onB = { titles, visible: ["Request A", "Request B"], files: { "b.txt": "b\n", "c.txt": undefined } }
        const onC = { titles, visible: ["Request A", "Request C"], files: { "b.txt": undefined, "c.txt": "c\n" } }

        yield* checkpoints.jump(chat.created.id, nodes["Request B"]!.key)
        yield* chat.expectAt(onB)
        yield* checkpoints.jump(chat.created.id, nodes["Request C"]!.key)
        yield* chat.expectAt(onC)
        yield* checkpoints.jump(chat.created.id, nodes["Request B"]!.key)
        yield* chat.expectAt(onB)
        expect(yield* CheckpointBranch.forRoot(chat.database.db, chat.created.id)).toHaveLength(1)
      }),
    timeout,
  )

  it.live(
    "three paths off one checkpoint are all listed once and reachable",
    () =>
      Effect.gen(function* () {
        const checkpoints = yield* Checkpoints.Service
        const chat = yield* conversation()
        yield* chat.request("Request A", chat.write("a.txt", "a edited\n"))
        yield* chat.request("Request B", chat.write("b.txt", "b\n"))
        const a = (yield* chat.keys())["Request A"]!.key
        yield* checkpoints.jump(chat.created.id, a)
        yield* chat.request("Request C", chat.write("c.txt", "c\n"))
        yield* checkpoints.jump(chat.created.id, a)
        yield* chat.request("Request D", chat.write("d.txt", "d\n"))
        const nodes = yield* chat.keys()
        const titles = ["Request A", "Request B", "Request C", "Request D"]
        expect(nodes["Request B"]!.parentKey).toBe(a)
        expect(nodes["Request C"]!.parentKey).toBe(a)
        expect(nodes["Request D"]!.parentKey).toBe(a)
        const only = (name: string) =>
          Object.fromEntries(
            ["b.txt", "c.txt", "d.txt"].map((file) => [file, file === name ? `${name[0]}\n` : undefined]),
          )

        yield* chat.expectAt({ titles, visible: ["Request A", "Request D"], files: only("d.txt") })
        yield* checkpoints.jump(chat.created.id, nodes["Request B"]!.key)
        yield* chat.expectAt({ titles, visible: ["Request A", "Request B"], files: only("b.txt") })
        yield* checkpoints.jump(chat.created.id, nodes["Request C"]!.key)
        yield* chat.expectAt({ titles, visible: ["Request A", "Request C"], files: only("c.txt") })
        yield* checkpoints.jump(chat.created.id, nodes["Request D"]!.key)
        yield* chat.expectAt({ titles, visible: ["Request A", "Request D"], files: only("d.txt") })
        yield* checkpoints.jump(chat.created.id, nodes["Request B"]!.key)
        yield* chat.expectAt({ titles, visible: ["Request A", "Request B"], files: only("b.txt") })
        expect(yield* CheckpointBranch.forRoot(chat.database.db, chat.created.id)).toHaveLength(2)
      }),
    timeout,
  )

  it.live(
    "a path stored with a staged revert comes back with it, and undo puts it back",
    () =>
      Effect.gen(function* () {
        const checkpoints = yield* Checkpoints.Service
        const chat = yield* conversation()
        yield* chat.request("Request A", chat.write("a.txt", "a edited\n"))
        yield* chat.request("Request B", chat.write("b.txt", "b\n"))
        yield* checkpoints.jump(chat.created.id, (yield* chat.keys())["Request A"]!.key)
        yield* chat.request("Request C", chat.write("c.txt", "c\n"))
        const nodes = yield* chat.keys()
        // B now lives on the kept copy of the old path, under that copy's message id.
        const b = nodes["Request B"]!.messageID
        const titles = ["Request A", "Request B", "Request C"]
        // Store A, B with B hidden: swap to it, step back to A, then swap away. A jump to a path's newest checkpoint
        // wakes the session, so the next jump waits for it.
        yield* checkpoints.jump(chat.created.id, nodes["Request B"]!.key)
        yield* chat.sessions.wait(chat.created.id)
        yield* checkpoints.jump(chat.created.id, nodes["Request A"]!.key)
        yield* checkpoints.jump(chat.created.id, nodes["Request C"]!.key)
        yield* chat.sessions.wait(chat.created.id)
        const [branch] = yield* CheckpointBranch.forRoot(chat.database.db, chat.created.id)
        expect((yield* chat.sessions.get(branch!.session_id)).revert?.messageID).toBe(b)
        expect(branch!.revert_message_id).toBe(b)
        const listed = yield* checkpoints.list(chat.created.id)
        expect(listed.nodes.find((node) => node.title === "Request B")?.path).toBe("branch")

        // Its newest checkpoint: the stored revert is cleared.
        yield* checkpoints.jump(chat.created.id, nodes["Request B"]!.key)
        expect((yield* chat.sessions.get(chat.created.id)).revert).toBeUndefined()
        yield* chat.expectAt({
          titles,
          visible: ["Request A", "Request B"],
          files: { "b.txt": "b\n", "c.txt": undefined },
        })

        yield* chat.sessions.wait(chat.created.id)
        expect(yield* checkpoints.undo(chat.created.id)).toBe(true)
        yield* chat.expectAt({
          titles,
          visible: ["Request A", "Request C"],
          files: { "b.txt": undefined, "c.txt": "c\n" },
        })
        expect((yield* chat.sessions.get(branch!.session_id)).revert?.messageID).toBe(b)

        // Back on the current path, the stored path keeps its revert.
        yield* checkpoints.jump(chat.created.id, nodes["Request A"]!.key)
        expect((yield* chat.sessions.get(chat.created.id)).revert?.messageID).toBe(nodes["Request C"]!.messageID)
        expect((yield* chat.sessions.get(branch!.session_id)).revert?.messageID).toBe(b)
        yield* chat.expectAt({
          titles,
          visible: ["Request A"],
          files: { "a.txt": "a edited\n", "b.txt": undefined, "c.txt": undefined },
        })
      }),
    timeout,
  )

  it.live(
    "a jump interrupted after the swap still finishes",
    () =>
      Effect.gen(function* () {
        const checkpoints = yield* Checkpoints.Service
        const bus = yield* Bus.Service
        const chat = yield* conversation()
        yield* chat.request("Request A", chat.write("a.txt", "a edited\n"))
        yield* chat.request("Request B", chat.write("b.txt", "b\n"))
        yield* checkpoints.jump(chat.created.id, (yield* chat.keys())["Request A"]!.key)
        yield* chat.request("Request C", chat.write("c.txt", "c\n"))
        const nodes = yield* chat.keys()

        // The caller goes away right after the conversation is swapped, before the files are restored.
        const swapped = yield* Deferred.make<void>()
        yield* bus.subscribe([SessionEvent.PathSwapped]).pipe(
          Stream.take(1),
          Stream.runForEach(() => Deferred.succeed(swapped, undefined)),
          Effect.forkScoped({ startImmediately: true }),
        )
        const jumping = yield* checkpoints
          .jump(chat.created.id, nodes["Request B"]!.key)
          .pipe(Effect.forkScoped({ startImmediately: true }))
        yield* Deferred.await(swapped)
        yield* Fiber.interrupt(jumping)

        yield* chat.expectAt({
          titles: ["Request A", "Request B", "Request C"],
          visible: ["Request A", "Request B"],
          files: { "b.txt": "b\n", "c.txt": undefined },
        })
        expect(yield* checkpoints.undo(chat.created.id)).toBe(true)
        expect(yield* chat.visible()).toEqual(["Request A", "Request C"])
      }),
    timeout,
  )

  it.live(
    "diff change and now return the right files",
    () =>
      Effect.gen(function* () {
        const checkpoints = yield* Checkpoints.Service
        const chat = yield* conversation()
        yield* chat.request("Request A", chat.write("a.txt", "a edited\n"))
        yield* chat.request("Request B", chat.write("b.txt", "b\n"))
        yield* Effect.promise(chat.write("other.txt", "someone else\n"))
        const nodes = yield* chat.keys()

        const change = yield* checkpoints.diff(chat.created.id, nodes["Request B"]!.key, "change")
        expect(change.map((file) => file.file)).toEqual(["b.txt"])
        const now = yield* checkpoints.diff(chat.created.id, nodes["Request A"]!.key, "now")
        expect(now.map((file) => file.file)).toEqual(["b.txt"])
      }),
    timeout,
  )
})
