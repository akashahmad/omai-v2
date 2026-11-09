import { describe, expect, test } from "bun:test"
import { createIdleLogout } from "./idle"

function harness() {
  const time = { now: 0 }
  const timers: { at: number; fn: () => void; cancelled: boolean }[] = []

  const schedule = (fn: () => void, ms: number) => {
    const timer = { at: time.now + ms, fn, cancelled: false }
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
      next.cancelled = true
      next.fn()
    }

    time.now = target
  }

  return { now: () => time.now, schedule, advance }
}

const activity = () => window.dispatchEvent(new Event("keydown"))

describe("createIdleLogout", () => {
  test("fires onIdle after 900000 ms with no activity", () => {
    const h = harness()
    const idle: number[] = []

    const dispose = createIdleLogout({
      timeoutMs: 900_000,
      onIdle: () => idle.push(h.now()),
      onActive: () => {},
      now: h.now,
      schedule: h.schedule,
    })

    h.advance(899_999)
    expect(idle).toEqual([])
    h.advance(1)
    expect(idle).toEqual([900_000])
    h.advance(2_000_000)
    expect(idle).toHaveLength(1)
    dispose()
  })

  test("activity resets the timer", () => {
    const h = harness()
    const idle: number[] = []

    const dispose = createIdleLogout({
      timeoutMs: 900_000,
      onIdle: () => idle.push(h.now()),
      onActive: () => {},
      now: h.now,
      schedule: h.schedule,
    })

    h.advance(800_000)
    activity()
    h.advance(800_000)
    expect(idle).toEqual([])
    h.advance(100_000)
    expect(idle).toEqual([1_700_000])
    dispose()
  })

  test("a broadcast from another tab resets the timer", async () => {
    const h = harness()
    const name = `idle-test-${Math.random()}`
    const idle: string[] = []

    const a = createIdleLogout({
      timeoutMs: 900_000,
      onIdle: () => idle.push("a"),
      onActive: () => {},
      now: h.now,
      schedule: h.schedule,
      channel: new BroadcastChannel(name),
    })

    const other = new BroadcastChannel(name)
    h.advance(800_000)
    other.postMessage({ type: "active" })
    await new Promise((resolve) => setTimeout(resolve, 20))
    h.advance(800_000)
    expect(idle).toEqual([])
    h.advance(100_000)
    expect(idle).toEqual(["a"])
    other.close()
    a()
  })

  test("onActive is throttled to once per 60 s", () => {
    const h = harness()
    const active: number[] = []

    const dispose = createIdleLogout({
      timeoutMs: 900_000,
      onIdle: () => {},
      onActive: () => active.push(h.now()),
      now: h.now,
      schedule: h.schedule,
    })

    activity()
    h.advance(30_000)
    activity()
    h.advance(31_000)
    activity()
    expect(active).toEqual([0, 61_000])
    dispose()
  })

  test("dispose stops listening", () => {
    const h = harness()
    const idle: number[] = []

    const dispose = createIdleLogout({
      timeoutMs: 1000,
      onIdle: () => idle.push(1),
      onActive: () => {},
      now: h.now,
      schedule: h.schedule,
    })

    dispose()
    h.advance(5000)
    expect(idle).toEqual([])
  })
})
