import { describe, expect, test } from "bun:test"
import { captureSchedule } from "@opencode/core/preview/schedule"

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe("captureSchedule", () => {
  test("waits for the page to settle, then captures once for many pokes", async () => {
    const runs: number[] = []
    const schedule = captureSchedule({ delay: 30, interval: 1000, run: async () => void runs.push(Date.now()) })
    schedule.poke()
    schedule.poke()
    schedule.poke()

    expect(runs).toHaveLength(0)
    await wait(60)
    expect(runs).toHaveLength(1)
    schedule.stop()
  })

  test("captures again only after the interval", async () => {
    const runs: number[] = []
    const schedule = captureSchedule({ delay: 10, interval: 120, run: async () => void runs.push(Date.now()) })
    schedule.poke()
    await wait(30)
    schedule.poke()
    await wait(40)

    expect(runs).toHaveLength(1)
    await wait(100)
    expect(runs).toHaveLength(2)
    expect(runs[1]! - runs[0]!).toBeGreaterThanOrEqual(110)
    schedule.stop()
  })

  test("a failed capture doesn't stop later ones, and stop cancels a pending one", async () => {
    const runs: string[] = []
    const schedule = captureSchedule({
      delay: 10,
      interval: 0,
      run: async () => {
        runs.push("run")
        throw new Error("no chrome")
      },
    })
    schedule.poke()
    await wait(30)
    schedule.poke()
    await wait(30)
    schedule.poke()
    schedule.stop()
    await wait(30)

    expect(runs).toEqual(["run", "run"])
  })
})
