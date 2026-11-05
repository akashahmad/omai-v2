import { describe, expect, test } from "bun:test"
import { Agent } from "@opencode/schema/agent"
import { Model } from "@opencode/schema/model"
import { Provider } from "@opencode/schema/provider"
import { SessionMessage } from "@opencode/schema/session-message"
import { RelativePath } from "@opencode/schema/schema"
import { Snapshot } from "@opencode/schema/snapshot"
import { deriveCheckpoints } from "@opencode/core/checkpoint/derive"
import { DateTime } from "effect"

function user(id: string, created: number, text: string) {
  return SessionMessage.User.make({
    id: SessionMessage.ID.make(id),
    type: "user",
    text,
    time: { created: DateTime.makeUnsafe(created) },
  })
}

function step(id: string, created: number, snapshot?: { start?: string; end?: string; files?: string[] }) {
  return SessionMessage.Assistant.make({
    id: SessionMessage.ID.make(id),
    type: "assistant",
    agent: Agent.ID.make("build"),
    model: { id: Model.ID.make("m"), providerID: Provider.ID.make("p") },
    content: [],
    snapshot: snapshot && {
      start: snapshot.start === undefined ? undefined : Snapshot.ID.make(snapshot.start),
      end: snapshot.end === undefined ? undefined : Snapshot.ID.make(snapshot.end),
      files: snapshot.files?.map((file) => RelativePath.make(file)),
    },
    time: { created: DateTime.makeUnsafe(created) },
  })
}

describe("deriveCheckpoints", () => {
  test("a request that changed files is a checkpoint", () => {
    const title = "Make the header blue\nand keep the logo"
    const result = deriveCheckpoints([
      user("msg_u1", 1000, `  ${title}  `),
      step("msg_a1", 1100, { start: "s0", end: "s1", files: ["a.ts", "b.ts"] }),
      step("msg_a2", 1200, { start: "s1", end: "s2", files: ["b.ts", "c.ts"] }),
    ])
    expect(result).toEqual([
      {
        key: "1000:s2",
        messageID: SessionMessage.ID.make("msg_u1"),
        title: "Make the header blue",
        time: 1000,
        files: ["a.ts", "b.ts", "c.ts"],
        start: Snapshot.ID.make("s0"),
        end: Snapshot.ID.make("s2"),
      },
    ])
  })

  test("titles are trimmed to 80 characters", () => {
    const result = deriveCheckpoints([
      user("msg_u1", 1, "x".repeat(200)),
      step("msg_a1", 2, { start: "s0", end: "s1", files: ["a.ts"] }),
    ])
    expect(result[0]?.title).toBe("x".repeat(80))
  })

  test("a request that changed no files is not a checkpoint", () => {
    expect(
      deriveCheckpoints([
        user("msg_u1", 1, "explain"),
        step("msg_a1", 2, { start: "s0", end: "s0", files: [] }),
        user("msg_u2", 3, "again"),
        step("msg_a2", 4),
      ]),
    ).toEqual([])
  })

  test("an unfinished request is not a checkpoint", () => {
    expect(
      deriveCheckpoints([
        user("msg_u1", 1, "edit"),
        step("msg_a1", 2, { start: "s0", end: "s1", files: ["a.ts"] }),
        step("msg_a2", 3, { start: "s1", files: ["b.ts"] }),
      ]),
    ).toEqual([])
  })

  test("keys are the same for a copied history", () => {
    const history = (suffix: string) => [
      user(`msg_u1${suffix}`, 1000, "one"),
      step(`msg_a1${suffix}`, 1100, { start: "s0", end: "s1", files: ["a.ts"] }),
    ]
    expect(deriveCheckpoints(history("x")).map((item) => item.key)).toEqual(
      deriveCheckpoints(history("y")).map((item) => item.key),
    )
  })

  test("checkpoints are in conversation order", () => {
    const result = deriveCheckpoints([
      user("msg_u1", 1000, "first"),
      step("msg_a1", 1100, { start: "s0", end: "s1", files: ["a.ts"] }),
      user("msg_u2", 2000, "second"),
      step("msg_a2", 2100, { start: "s1", end: "s2", files: ["b.ts"] }),
    ])
    expect(result.map((item) => item.title)).toEqual(["first", "second"])
  })
})
