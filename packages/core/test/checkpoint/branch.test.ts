import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { Bus } from "@opencode/core/bus"
import { CheckpointBranch } from "@opencode/core/checkpoint/branch"
import { Database } from "@opencode/core/database/database"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Location } from "@opencode/core/location"
import { LocationServiceMap } from "@opencode/core/location-service-map"
import { Project } from "@opencode/core/project"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { SessionExecution } from "@opencode/core/session/execution"
import { SessionProjector } from "@opencode/core/session/projector"
import { SessionStore } from "@opencode/core/session/store"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { testEffect } from "../lib/effect"
import { promptLocationNode } from "../fixture/prompt-location"
import { globalProjectNode } from "../lib/project"

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, Bus.node, SessionProjector.node, SessionStore.node, Session.node]),
    [
      Bus.node.replace(Bus.configured({ persist: true })),
      Project.node.replace(globalProjectNode),
      LocationServiceMap.node.replace(promptLocationNode),
      SessionExecution.node.replace(SessionExecution.noopLayer),
    ],
  ),
)
const location = Location.Ref.make({ directory: AbsolutePath.make("/project") })

const setup = Effect.gen(function* () {
  const session = yield* Session.Service
  const { db } = yield* Database.Service
  const store = yield* SessionStore.Service
  const root = yield* session.create({ location, title: "root" })
  const branch = yield* session.create({ location, title: "branch" })
  yield* CheckpointBranch.record(db, {
    session_id: branch.id,
    root_session_id: root.id,
    parent_session_id: root.id,
    boundary_key: "",
    revert_message_id: null,
    time_created: 1,
  })
  return { session, db, store, root, branch }
})

describe("CheckpointBranch", () => {
  it.live("a recorded branch is not listed as a session", () =>
    Effect.gen(function* () {
      const { store, root, branch } = yield* setup
      const top = yield* store.list({ parentID: null })
      expect(top.map((item) => item.id)).toEqual([root.id])
      expect(top.map((item) => item.id)).not.toContain(branch.id)
      expect(yield* store.list({ parentID: root.id })).toEqual([])
      expect((yield* store.list({})).map((item) => item.id)).toEqual([root.id])
    }),
  )

  it.live("rootOf a branch is its root; rootOf a plain session is itself", () =>
    Effect.gen(function* () {
      const { db, root, branch } = yield* setup
      expect(yield* CheckpointBranch.rootOf(db, branch.id)).toBe(root.id)
      expect(yield* CheckpointBranch.rootOf(db, root.id)).toBe(root.id)
      expect((yield* CheckpointBranch.forRoot(db, root.id)).map((row) => row.session_id)).toEqual([branch.id])
    }),
  )

  it.live("removing the root removes its branches", () =>
    Effect.gen(function* () {
      const { session, db, store, root, branch } = yield* setup
      yield* session.remove(root.id)
      expect(yield* store.get(branch.id)).toBeUndefined()
      expect(yield* CheckpointBranch.forRoot(db, root.id)).toEqual([])
    }),
  )
})
