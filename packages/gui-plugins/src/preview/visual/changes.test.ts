import { describe, expect, test } from "bun:test"
import { empty, grouped, record, redo, remove, undo } from "./changes"
import type { LiveChange } from "./protocol"

const fingerprint = { tag: "p", classes: [], attrs: {}, index: 1 }

const style = (path: string, property: string, before: string, after: string): LiveChange => ({
  path,
  fingerprint,
  kind: "style",
  property,
  before,
  after,
})

describe("pending changes", () => {
  test("merges the same element and property, keeping the first before", () => {
    const pending = record(record(empty(), style("p", "font-size", "16px", "20px")), style("p", "font-size", "20px", "24px"))

    expect(pending.items).toEqual([style("p", "font-size", "16px", "24px")])
  })

  test("a change back to its original value drops the item", () => {
    const pending = record(record(empty(), style("p", "color", "red", "blue")), style("p", "color", "blue", "red"))

    expect(pending.items).toEqual([])
  })

  test("undo returns what to revert and redo re-applies it", () => {
    const first = style("p", "color", "red", "blue")
    const second = style("h1", "color", "black", "green")
    const pending = record(record(empty(), first), second)
    const undone = undo(pending)

    expect(undone.revert).toEqual([second])
    expect(undone.apply).toEqual([])
    expect(undone.pending.items).toEqual([first])
    const redone = redo(undone.pending)

    expect(redone.apply).toEqual([second])
    expect(redone.pending.items).toEqual([first, second])
  })

  test("undo of a merged change restores the earlier value", () => {
    const pending = record(record(empty(), style("p", "font-size", "16px", "20px")), style("p", "font-size", "20px", "24px"))
    const undone = undo(pending)

    expect(undone.pending.items).toEqual([style("p", "font-size", "16px", "20px")])
    // The page goes back to 20px, not to the original value.
    expect(undone.revert).toEqual([])
    expect(undone.apply).toEqual([style("p", "font-size", "16px", "20px")])
  })

  test("a new change after undo clears redo", () => {
    const undone = undo(record(empty(), style("p", "color", "red", "blue"))).pending
    const next = record(undone, style("p", "margin-top", "0px", "8px"))

    expect(redo(next).apply).toEqual([])
  })

  test("remove one change returns its revert", () => {
    const pending = record(record(empty(), style("p", "color", "red", "blue")), style("h1", "color", "black", "green"))
    const removed = remove(pending, 0)

    expect(removed.revert).toEqual(style("p", "color", "red", "blue"))
    expect(removed.pending.items).toEqual([style("h1", "color", "black", "green")])
  })

  test("grouped keeps first-seen element order", () => {
    const items = [style("p", "color", "a", "b"), style("h1", "color", "a", "b"), style("p", "margin-top", "0", "1")]

    expect(grouped(items).map((group) => [group.path, group.changes.length])).toEqual([
      ["p", 2],
      ["h1", 1],
    ])
  })
})
