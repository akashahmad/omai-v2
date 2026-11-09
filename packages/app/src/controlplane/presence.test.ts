import { describe, expect, test } from "bun:test"
import { createPresence, projectOfConnection } from "./presence"

function harness() {
  const time = { now: 0 }
  const timers: { at: number; every: number; fn: () => void; cancelled: boolean }[] = []

  const every = (fn: () => void, ms: number) => {
    const timer = { at: time.now + ms, every: ms, fn, cancelled: false }
    timers.push(timer)

    return () => {
      timer.cancelled = true
    }
  }

  const advance = (ms: number) => {
    const target = time.now + ms

    for (;;) {
      const next = timers.filter((t) => !t.cancelled && t.at <= target).sort((a, b) => a.at - b.at)[0]

      if (!next) break
      time.now = next.at
      next.at += next.every
      next.fn()
    }

    time.now = target
  }

  return { now: () => time.now, every, advance }
}

const interact = () => window.dispatchEvent(new Event("pointerdown"))

function setup(input: { project?: string; visible?: boolean; framed?: boolean } = {}) {
  const h = harness()
  const sent: { id: string; at: number }[] = []
  const state = {
    project: "project" in input ? input.project : "p1",
    visible: input.visible ?? true,
    framed: input.framed ?? false,
  }
  const dispose = createPresence({
    projectID: () => state.project,
    send: (id) => sent.push({ id, at: h.now() }),
    now: h.now,
    every: h.every,
    visible: () => state.visible,
    framed: () => state.framed,
  })

  return { h, sent, state, dispose }
}

describe("createPresence", () => {
  test("sends every 30 s while active and visible", () => {
    const s = setup()
    interact()
    s.h.advance(30_000)
    interact()
    s.h.advance(30_000)
    expect(s.sent).toEqual([
      { id: "p1", at: 0 },
      { id: "p1", at: 30_000 },
      { id: "p1", at: 60_000 },
    ])
    s.dispose()
  })

  test("stops after 2 minutes without interaction", () => {
    const s = setup()
    interact()
    s.h.advance(180_000)
    expect(s.sent.map((item) => item.at)).toEqual([0, 30_000, 60_000, 90_000])
    s.dispose()
  })

  test("silent while hidden", () => {
    const s = setup({ visible: false })
    interact()
    s.h.advance(60_000)
    expect(s.sent).toEqual([])
    s.dispose()
  })

  test("no project, no ping", () => {
    const s = setup({ project: undefined })
    interact()
    s.h.advance(60_000)
    expect(s.sent).toEqual([])
    s.dispose()
  })

  test("nothing after dispose", () => {
    const s = setup()
    s.dispose()
    interact()
    s.h.advance(60_000)
    expect(s.sent).toEqual([])
  })
})

describe("createPresence in the preview", () => {
  test("someone working inside the preview frame counts as using the project", () => {
    const s = setup({ framed: true })
    s.h.advance(180_000)
    expect(s.sent.map((item) => item.at)).toEqual([30_000, 60_000, 90_000, 120_000, 150_000, 180_000])
    s.dispose()
  })

  test("the first interaction after a quiet spell is sent at once", () => {
    const s = setup()
    s.h.advance(200_000)
    expect(s.sent).toEqual([])
    interact()
    expect(s.sent).toEqual([{ id: "p1", at: 200_000 }])
    interact()
    expect(s.sent).toHaveLength(1)
    s.dispose()
  })
})

describe("projectOfConnection", () => {
  test("reads the project from a VM connection's address", () => {
    expect(projectOfConnection("http://router.test/vm/p%201")).toBe("p 1")
    expect(projectOfConnection("http://router.test/vm/p1/")).toBe("p1")
    expect(projectOfConnection("http://localhost:4096")).toBeUndefined()
  })
})
