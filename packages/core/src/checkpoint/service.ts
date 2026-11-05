export * as Checkpoints from "./service.js"

import { and, desc, eq, ne } from "drizzle-orm"
import { Context, Effect, Layer, Option, Schema, Semaphore, Stream } from "effect"
import type { FileDiff } from "@opencode/schema/file-diff"
import { Node } from "@opencode/util/effect/app-node"
import type { LayerNode } from "@opencode/util/effect/layer-node"
import { Bus } from "../bus.js"
import { Database } from "../database/database.js"
import type { Instance } from "../instance.js"
import { Location } from "../location.js"
import { LocationServiceMap } from "../location-service-map.js"
import { RelativePath } from "../schema.js"
import { Session } from "../session.js"
import { BusyError, NotFoundError } from "../session/error.js"
import { SessionEvent } from "../session/event.js"
import { SessionExecution } from "../session/execution.js"
import type { SessionMessage } from "../session/message.js"
import { SessionSchema } from "../session/schema.js"
import { SessionInboxTable, SessionMessageTable } from "../session/sql.js"
import { Snapshot } from "../snapshot.js"
import { CheckpointBranch } from "./branch.js"
import { type Checkpoint, deriveCheckpoints, readMessages, type Source } from "./derive.js"

/**
 * One checkpoint in a conversation's tree. `current` checkpoints are visible on the path the user is on, `ahead` ones
 * are hidden by a staged revert on that path, and `branch` ones live only on a stored path. `parentKey` is the
 * checkpoint before it on its path.
 */
export type Node = Checkpoint & {
  path: "current" | "ahead" | "branch"
  branchID?: SessionSchema.ID
  parentKey?: string
}

export class MissingError extends Schema.TaggedError<MissingError>()("Checkpoint.MissingError", {
  sessionID: SessionSchema.ID,
  key: Schema.String,
}) {}

/** The session has queued messages; a jump would leave them on the path it moves away from. */
export class QueuedError extends Schema.TaggedError<QueuedError>()("Checkpoint.QueuedError", {
  sessionID: SessionSchema.ID,
}) {}

export interface Interface {
  readonly list: (
    sessionID: SessionSchema.ID,
  ) => Effect.Effect<{ available: boolean; nodes: Node[]; current?: string }, NotFoundError>
  /** `change`: what that request changed. `now`: that checkpoint against the current files this conversation touched. */
  readonly diff: (
    sessionID: SessionSchema.ID,
    key: string,
    mode: "change" | "now",
  ) => Effect.Effect<readonly FileDiff.Info[], NotFoundError | MissingError>
  readonly jump: (
    sessionID: SessionSchema.ID,
    key: string,
  ) => Effect.Effect<void, BusyError | QueuedError | NotFoundError | MissingError>
  /**
   * Returns files and conversation to the state captured just before the last jump. False when there is nothing to
   * undo: no jump, already undone, or the conversation changed since.
   */
  readonly undo: (sessionID: SessionSchema.ID) => Effect.Effect<boolean, BusyError | QueuedError | NotFoundError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Checkpoints") {}

type Paths = {
  visible: Source[]
  checkpoints: Checkpoint[]
  branches: { branchID: SessionSchema.ID; checkpoints: Checkpoint[] }[]
}

type Undo = {
  /** The files as they were just before the jump. */
  snapshot?: Snapshot.ID
  revert: SessionSchema.Info["revert"]
  swap?: {
    branch: CheckpointBranch.Row
    revert: SessionSchema.Info["revert"]
  }
  /** What the conversation looked like right after the jump; undo is refused once it changes. */
  after: { lastMessageID?: SessionMessage.ID; revertMessageID?: SessionMessage.ID }
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const database = yield* Database.Service
    const bus = yield* Bus.Service
    const locations = yield* LocationServiceMap.Service
    const execution = yield* SessionExecution.Service
    // Jumps and undos read, swap and restore in several steps; one at a time keeps them from interleaving.
    const lock = Semaphore.makeUnsafe(1)
    // Kept in memory: a jump can be undone right after, not after a restart.
    const undos = new Map<SessionSchema.ID, Undo>()
    yield* bus.subscribe([SessionEvent.Deleted]).pipe(
      Stream.runForEach((event) => Effect.sync(() => undos.delete(event.data.sessionID))),
      Effect.forkScoped({ startImmediately: true }),
    )

    const messages = (sessionID: SessionSchema.ID) => readMessages(database.db, sessionID).pipe(Effect.orDie)

    const inLocation = <A, E>(session: SessionSchema.Info, effect: Effect.Effect<A, E, Instance.Services>) =>
      effect.pipe(Effect.provide(locations.get(session.location)), Effect.orDie)

    const paths = Effect.fn("Checkpoints.paths")(function* (session: SessionSchema.Info) {
      const visible = yield* messages(session.id)
      const root = yield* CheckpointBranch.rootOf(database.db, session.id)
      const rows = yield* CheckpointBranch.forRoot(database.db, root)
      const branches = yield* Effect.forEach(
        rows.filter((row) => row.session_id !== session.id).toSorted((a, b) => a.time_created - b.time_created),
        (row) =>
          messages(row.session_id).pipe(
            Effect.map((stored) => ({ branchID: row.session_id, checkpoints: deriveCheckpoints(stored) })),
          ),
      )
      return { visible, checkpoints: deriveCheckpoints(visible), branches } satisfies Paths
    })

    const requireIdle = Effect.fn("Checkpoints.requireIdle")(function* (session: SessionSchema.Info) {
      const active = yield* sessions.active
      const working = yield* Effect.forEach(Array.from(active), (sessionID) =>
        sessions.get(sessionID).pipe(Effect.option),
      )
      const busy = working.flatMap((found) =>
        Option.isSome(found) && found.value.projectID === session.projectID ? [found.value] : [],
      )[0]
      if (busy) return yield* new BusyError({ sessionID: busy.id })
      // Queued messages are numbered by the history they were sent on: after a swap the next revert commit could drop
      // them, so a jump waits until they are delivered.
      const queued = yield* database.db
        .select({ id: SessionInboxTable.id })
        .from(SessionInboxTable)
        .where(eq(SessionInboxTable.session_id, session.id))
        .limit(1)
        .get()
        .pipe(Effect.orDie)
      if (queued) return yield* new QueuedError({ sessionID: session.id })
    })

    const setRevert = (sessionID: SessionSchema.ID, revert: SessionSchema.Info["revert"]) =>
      revert
        ? bus.publish(SessionEvent.RevertEvent.Staged, { sessionID, revert })
        : bus.publish(SessionEvent.RevertEvent.Cleared, { sessionID })

    // Idle markers are left out: a redo wakes the session, which can record one after the jump.
    const fingerprint = Effect.fn("Checkpoints.fingerprint")(function* (sessionID: SessionSchema.ID) {
      const session = yield* sessions.get(sessionID)
      const last = yield* database.db
        .select({ id: SessionMessageTable.id })
        .from(SessionMessageTable)
        .where(and(eq(SessionMessageTable.session_id, sessionID), ne(SessionMessageTable.type, "idle")))
        .orderBy(desc(SessionMessageTable.seq))
        .limit(1)
        .get()
        .pipe(Effect.orDie)
      return { lastMessageID: last?.id, revertMessageID: session.revert?.messageID }
    })

    const list = Effect.fn("Checkpoints.list")(function* (sessionID: SessionSchema.ID) {
      const session = yield* sessions.get(sessionID)
      const nodes = tree(session, yield* paths(session))
      const available = yield* inLocation(
        session,
        Effect.map(Location.Service, (location) => location.vcs?.type === "git"),
      )
      return { available, nodes, current: nodes.findLast((node) => node.path === "current")?.key }
    })

    const diff = Effect.fn("Checkpoints.diff")(function* (
      sessionID: SessionSchema.ID,
      key: string,
      mode: "change" | "now",
    ) {
      const session = yield* sessions.get(sessionID)
      const all = yield* paths(session)
      const target = locate(all, key)
      if (!target) return yield* new MissingError({ sessionID, key })
      const checkpoint = target.checkpoint
      return yield* inLocation(
        session,
        Effect.gen(function* () {
          const snapshot = yield* Snapshot.Service
          if (!checkpoint.end) return []
          if (mode === "change")
            return checkpoint.start
              ? yield* snapshot.diff({
                  from: checkpoint.start,
                  to: checkpoint.end,
                  paths: checkpoint.files.map((file) => RelativePath.make(file)),
                })
              : []
          const now = yield* snapshot.capture()
          if (!now) return []
          return yield* snapshot.diff({ from: checkpoint.end, to: now, paths: touched(all) })
        }),
      )
    })

    const jump = Effect.fn("Checkpoints.jump")(function* (sessionID: SessionSchema.ID, key: string) {
      const session = yield* sessions.get(sessionID)
      yield* requireIdle(session)
      const before = yield* paths(session)
      const target = locate(before, key)
      if (!target?.checkpoint.end) return yield* new MissingError({ sessionID, key })
      const end = target.checkpoint.end
      const files = touched(before)
      const snapshot = yield* inLocation(
        session,
        Effect.flatMap(Snapshot.Service, (snapshot) => snapshot.capture()),
      )
      const branchID = target.branchID
      const swap = branchID ? yield* swapIn(session, before, branchID, files) : undefined

      // Show the conversation up to the target: hide the requests after it, or show everything when it is the newest.
      const visible = yield* messages(sessionID)
      const index = visible.findIndex((message) => message.id === target.checkpoint.messageID)
      const next = visible.slice(index + 1).find((message) => message.type === "user")
      const newest = deriveCheckpoints(visible).at(-1)?.key === key
      // Clearing a revert normally wakes the session; here the wake waits until the files are back.
      if (newest) yield* sessions.revert.clear(sessionID, { resume: false }).pipe(Effect.orDie)
      if (!newest && next) yield* sessions.revert.stage({ sessionID, messageID: next.id }).pipe(Effect.orDie)

      yield* restore(session, files, end)
      if (newest) yield* execution.wake(sessionID)
      undos.delete(sessionID)
      // Only the newest jumps stay undoable; the map keeps insertion order, so the first entry is the oldest.
      const oldest = undos.keys().next()
      if (undos.size >= UndoLimit && !oldest.done) undos.delete(oldest.value)
      undos.set(sessionID, {
        snapshot,
        revert: session.revert,
        swap,
        after: yield* fingerprint(sessionID),
      })
    })

    /** Makes the branch's path the visible one and stores the path being left in that branch. */
    const swapIn = Effect.fn("Checkpoints.swapIn")(function* (
      session: SessionSchema.Info,
      before: Paths,
      branchID: SessionSchema.ID,
      files: readonly RelativePath[],
    ) {
      const root = yield* CheckpointBranch.rootOf(database.db, session.id)
      const branch = (yield* CheckpointBranch.forRoot(database.db, root)).find((row) => row.session_id === branchID)
      if (!branch) return yield* Effect.die(new Error(`Checkpoint branch not found: ${branchID}`))
      const stored = yield* sessions.get(branchID).pipe(Effect.orDie)
      const incoming = before.branches.find((path) => path.branchID === branchID)?.checkpoints ?? []
      yield* bus.publish(SessionEvent.PathSwapped, { sessionID: session.id, branchID })
      yield* CheckpointBranch.update(database.db, branchID, {
        parent_session_id: session.id,
        boundary_key: splitKey(before.checkpoints, incoming),
        revert_message_id: session.revert?.messageID ?? null,
      })
      // A path stored without a revert sits at its newest checkpoint; put its files there first so a revert staged on
      // it remembers that state for redo.
      const tip = incoming.at(-1)?.end
      if (!stored.revert && tip) yield* restore(session, files, tip)
      return { branch, revert: stored.revert }
    })

    const restore = Effect.fn("Checkpoints.restore")(function* (
      session: SessionSchema.Info,
      files: readonly RelativePath[],
      tree: Snapshot.ID,
    ) {
      if (files.length === 0) return
      yield* inLocation(
        session,
        Effect.flatMap(Snapshot.Service, (snapshot) =>
          snapshot.restore({ files: new Map(files.map((file) => [file, tree])) }),
        ),
      )
    })

    const undo = Effect.fn("Checkpoints.undo")(function* (sessionID: SessionSchema.ID) {
      const state = undos.get(sessionID)
      if (!state) return false
      const session = yield* sessions.get(sessionID)
      yield* requireIdle(session)
      undos.delete(sessionID)
      const now = yield* fingerprint(sessionID)
      if (now.lastMessageID !== state.after.lastMessageID || now.revertMessageID !== state.after.revertMessageID)
        return false
      const files = touched(yield* paths(session))
      const swap = state.swap
      if (swap) {
        yield* bus.publish(SessionEvent.PathSwapped, { sessionID, branchID: swap.branch.session_id })
        yield* CheckpointBranch.update(database.db, swap.branch.session_id, {
          parent_session_id: swap.branch.parent_session_id,
          boundary_key: swap.branch.boundary_key,
          revert_message_id: swap.branch.revert_message_id,
        })
        yield* setRevert(swap.branch.session_id, swap.revert)
      }
      yield* setRevert(sessionID, state.revert)
      if (state.snapshot) yield* restore(session, files, state.snapshot)
      return true
    })

    return Service.of({
      list,
      diff,
      // Uninterruptible once holding the lock: a cancelled caller must not stop between the swap, the revert and the
      // file restore, which would leave the conversation and the files on different paths.
      jump: (sessionID, key) => lock.withPermit(Effect.uninterruptible(jump(sessionID, key))),
      undo: (sessionID) => lock.withPermit(Effect.uninterruptible(undo(sessionID))),
    })
  }),
)

const UndoLimit = 100

function tree(session: SessionSchema.Info, all: Paths) {
  const boundary = session.revert ? all.visible.findIndex((message) => message.id === session.revert?.messageID) : -1
  const ahead = new Set(boundary < 0 ? [] : all.visible.slice(boundary).map((message) => message.id))
  const visible = all.checkpoints.map(
    (checkpoint, index): Node => ({
      ...checkpoint,
      path: ahead.has(checkpoint.messageID) ? "ahead" : "current",
      parentKey: all.checkpoints[index - 1]?.key,
    }),
  )
  const seen = new Set(visible.map((node) => node.key))
  const stored = all.branches.flatMap((branch) =>
    branch.checkpoints.flatMap((checkpoint, index): Node[] => {
      if (seen.has(checkpoint.key)) return []
      seen.add(checkpoint.key)
      return [
        { ...checkpoint, path: "branch", branchID: branch.branchID, parentKey: branch.checkpoints[index - 1]?.key },
      ]
    }),
  )
  return [...visible, ...stored]
}

/** The target on the visible path, or the first stored path that holds it. */
function locate(all: Paths, key: string) {
  const visible = all.checkpoints.find((checkpoint) => checkpoint.key === key)
  if (visible) return { checkpoint: visible, branchID: undefined }
  return all.branches.flatMap((branch) =>
    branch.checkpoints
      .filter((checkpoint) => checkpoint.key === key)
      .map((checkpoint) => ({ checkpoint, branchID: branch.branchID })),
  )[0]
}

/** Every file a request of this conversation changed, on any of its paths. */
function touched(all: Paths) {
  return Array.from(
    new Set(
      [...all.checkpoints, ...all.branches.flatMap((branch) => branch.checkpoints)].flatMap(
        (checkpoint) => checkpoint.files,
      ),
    ),
    (file) => RelativePath.make(file),
  )
}

/** The last checkpoint two paths share; empty when they split before the first. */
function splitKey(left: readonly Checkpoint[], right: readonly Checkpoint[]) {
  const shared = left.findIndex((checkpoint, index) => right[index]?.key !== checkpoint.key)
  const count = shared < 0 ? Math.min(left.length, right.length) : shared
  return left[count - 1]?.key ?? ""
}

// Annotated to break the type cycle with plugins, which require this service while the location map requires them.
export const node: LayerNode.Provider<Service, never, typeof Node.tags.values.global> = Node.makeGlobalNode({
  service: Service,
  layer,
  deps: [Session.node, Database.node, Bus.node, LocationServiceMap.node, SessionExecution.node],
})
