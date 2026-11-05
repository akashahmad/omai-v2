import { describe, expect, test } from "bun:test"
import type { Checkpoint } from "@opencode/schema/checkpoint"
import { confirmText, failureText, holdsRefusal, layout, rails, relativeTime, timeline } from "./model"

const words = {
  t: (key: string, params: Record<string, string | number> = {}) =>
    `${key}${Object.keys(params).length ? JSON.stringify(params) : ""}`,
  plural: (key: string, count: number) => `${key}#${count}`,
  locale: "en",
}

const node = (key: string, input: Partial<Checkpoint.Node> = {}): Checkpoint.Node => ({
  key,
  messageID: `msg-${key}`,
  title: `Request ${key}`,
  time: 0,
  files: ["src/a.ts"],
  path: "current",
  ...input,
})

describe("rails", () => {
  test("joins a path's checkpoints and carries the trunk past a branch", () => {
    const rows = layout([
      node("a"),
      node("b", { parentKey: "a" }),
      node("c", { parentKey: "b", path: "ahead" }),
      node("x", { parentKey: "a", path: "branch", branchID: "s1" }),
      node("y", { parentKey: "x", path: "branch", branchID: "s1" }),
    ])

    expect(rails(rows)).toEqual([
      { up: false, down: true, through: [] },
      { up: false, down: true, through: [0] },
      { up: true, down: false, through: [0] },
      { up: true, down: true, through: [] },
      { up: true, down: false, through: [] },
    ])
  })

  test("a lone checkpoint has no line, and a branch off the last checkpoint doesn't extend the trunk", () => {
    expect(rails(layout([node("a")]))).toEqual([{ up: false, down: false, through: [] }])
    expect(rails(layout([node("a"), node("x", { parentKey: "a", path: "branch", branchID: "s1" })]))).toEqual([
      { up: false, down: true, through: [] },
      { up: false, down: false, through: [] },
    ])
  })

  test("carries a path's line down to every branch hanging off it", () => {
    const rows = layout([
      node("a"),
      node("x", { parentKey: "a", path: "branch", branchID: "s1" }),
      node("y", { parentKey: "x", path: "branch", branchID: "s1" }),
      node("z", { parentKey: "a", path: "branch", branchID: "s2" }),
    ])

    expect(rows.map((row) => row.node.key)).toEqual(["a", "x", "y", "z"])
    expect(rails(rows).map((rail) => rail.through)).toEqual([[], [0], [0], []])
    expect(rails(rows)[0]?.down).toBe(true)
  })
})

describe("timeline", () => {
  test("lists newest first, with each row's lines flipped so they still join the same checkpoints", () => {
    const entries = timeline([
      node("a"),
      node("b", { parentKey: "a" }),
      node("x", { parentKey: "a", path: "branch", branchID: "s1" }),
    ])

    expect(entries.map((entry) => [entry.row.node.key, entry.rail.up, entry.rail.down, entry.rail.through])).toEqual([
      ["b", false, true, []],
      ["x", false, false, [0]],
      ["a", true, false, []],
    ])
  })
})

describe("layout", () => {
  test("puts the trunk at depth 0 and a branch at depth 1 under the checkpoint it split from", () => {
    const rows = layout([
      node("a"),
      node("b", { parentKey: "a" }),
      node("c", { parentKey: "b", path: "ahead" }),
      node("x", { parentKey: "a", path: "branch", branchID: "s1" }),
      node("y", { parentKey: "x", path: "branch", branchID: "s1" }),
    ])

    expect(rows.map((row) => [row.node.key, row.depth, row.split])).toEqual([
      ["a", 0, false],
      ["x", 1, true],
      ["y", 1, false],
      ["b", 0, false],
      ["c", 0, false],
    ])
  })

  test("nests a branch that split from another branch one level deeper", () => {
    const rows = layout([
      node("a"),
      node("x", { parentKey: "a", path: "branch", branchID: "s1" }),
      node("y", { parentKey: "x", path: "branch", branchID: "s1" }),
      node("z", { parentKey: "x", path: "branch", branchID: "s2" }),
    ])

    expect(rows.map((row) => [row.node.key, row.depth, row.split])).toEqual([
      ["a", 0, false],
      ["x", 1, true],
      ["z", 2, true],
      ["y", 1, false],
    ])
  })

  test("shows a branch that split before the first checkpoint above the trunk, and every node once", () => {
    const nodes = [
      node("a"),
      node("x", { path: "branch", branchID: "s1" }),
      node("y", { parentKey: "gone", path: "branch", branchID: "s2" }),
    ]

    const rows = layout(nodes)

    expect(rows.map((row) => [row.node.key, row.depth, row.split])).toEqual([
      ["x", 1, true],
      ["y", 1, true],
      ["a", 0, false],
    ])
    expect(rows).toHaveLength(nodes.length)
  })
})

describe("relativeTime", () => {
  const now = 1_800_000_000_000

  test("reads milliseconds: a minute ago is one minute, not a thousand", () => {
    expect(relativeTime(now - 60_000, now, words)).toBe("checkpoints.time.minutes#1")
  })

  test("says just now under a minute", () => {
    expect(relativeTime(now - 5_000, now, words)).toBe("checkpoints.time.now")
  })

  test("counts hours and days", () => {
    expect(relativeTime(now - 3 * 3_600_000, now, words)).toBe("checkpoints.time.hours#3")
    expect(relativeTime(now - 2 * 86_400_000, now, words)).toBe("checkpoints.time.days#2")
  })

  test("shows a date after a month", () => {
    expect(relativeTime(now - 40 * 86_400_000, now, words)).toBe(
      new Intl.DateTimeFormat("en", { dateStyle: "medium" }).format(now - 40 * 86_400_000),
    )
  })
})

describe("confirmText", () => {
  test("names the conversation, the files it overwrites and the undo", () => {
    const text = confirmText(node("a", { title: "Add a header" }), ["src/a.ts", "src/b.ts"], words)

    expect(text.title).toBe("checkpoints.confirm.title")
    expect(text.confirm).toBe("checkpoints.confirm.go")
    expect(text.description).toBe(
      [
        'checkpoints.confirm.conversation{"title":"Add a header"}',
        "checkpoints.confirm.files#2\nsrc/a.ts\nsrc/b.ts",
        "checkpoints.confirm.undo",
      ].join("\n\n"),
    )
  })

  test("says the files already match when nothing would be overwritten", () => {
    expect(confirmText(node("a", { title: "Fix" }), [], words).description).toBe(
      [
        'checkpoints.confirm.conversation{"title":"Fix"}',
        "checkpoints.confirm.noFiles",
        "checkpoints.confirm.undo",
      ].join("\n\n"),
    )
  })

  test("never claims the files match when they could not be listed", () => {
    expect(confirmText(node("a", { title: "Fix" }), undefined, words).description.split("\n\n")[1]).toBe(
      "checkpoints.confirm.unknownFiles",
    )
  })

  test("lists at most six files and counts the rest", () => {
    const files = Array.from({ length: 9 }, (_, index) => `f${index}`)

    expect(confirmText(node("a"), files, words).description.split("\n\n")[1]).toBe(
      ["checkpoints.confirm.files#9", ...files.slice(0, 6), 'checkpoints.confirm.more{"count":3}'].join("\n"),
    )
  })

  test("falls back to a generic name for a request without text", () => {
    expect(confirmText(node("a", { title: "" }), [], words).description.split("\n\n")[0]).toBe(
      'checkpoints.confirm.conversation{"title":"checkpoints.untitled"}',
    )
  })
})

describe("holdsRefusal", () => {
  test("keeps a refusal while the session it named runs", () => {
    expect(holdsRefusal({ known: true, running: true })).toBe(true)
  })

  test("drops it once that session is idle", () => {
    expect(holdsRefusal({ known: true, running: false })).toBe(false)
  })

  test("keeps it until the next action when this window does not know that session", () => {
    expect(holdsRefusal({ known: false, running: false })).toBe(true)
  })
})

describe("failureText", () => {
  test("asks to wait when queued messages block a jump", () => {
    expect(failureText({ type: "checkpoint.queued", message: "Wait for queued messages to be delivered" }, words)).toBe(
      "checkpoints.error.queued",
    )
  })

  test("names a missing checkpoint, and otherwise shows the server's message", () => {
    expect(failureText({ type: "checkpoint.missing" }, words)).toBe("checkpoints.error.missing")
    expect(failureText({ type: "other", message: "Disk full" }, words)).toBe("Disk full")
    expect(failureText({}, words)).toBe("checkpoints.error.failed")
  })
})
