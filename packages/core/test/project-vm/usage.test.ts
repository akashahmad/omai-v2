import { describe, expect, test } from "bun:test"
import { ProjectVmUsage } from "@opencode/core/project-vm/usage"

const tokens = (input: number, output: number) => ({ input, output, reasoning: 0, cache: { read: 0, write: 0 } })

describe("ProjectVmUsage", () => {
  test("each ended step is queued with its model; a full queue drops the oldest", () => {
    const usage = ProjectVmUsage.create({ limit: 2 })
    usage.started({ assistantMessageID: "m1", model: { providerID: "openai", id: "gpt-5" } })
    usage.ended({ assistantMessageID: "m1", tokens: tokens(3, 4) }, 1000)
    usage.ended({ assistantMessageID: "unknown", tokens: tokens(1, 1) }, 1001)
    expect(usage.take()).toEqual([
      { providerID: "openai", modelID: "gpt-5", inputTokens: 3, outputTokens: 4, at: 1000 },
    ])
    expect(usage.take()).toEqual([])
    for (const id of ["a", "b", "c"]) {
      usage.started({ assistantMessageID: id, model: { providerID: "p", id } })
      usage.ended({ assistantMessageID: id, tokens: tokens(1, 1) }, 1)
    }
    expect(usage.take().map((step) => step.modelID)).toEqual(["b", "c"])
  })

  test("a failed send puts the steps back", () => {
    const usage = ProjectVmUsage.create({ limit: 10 })
    usage.started({ assistantMessageID: "m1", model: { providerID: "openai", id: "gpt-5" } })
    usage.ended({ assistantMessageID: "m1", tokens: tokens(3, 4) }, 1000)
    const steps = usage.take()
    usage.restore(steps)
    expect(usage.take()).toEqual(steps)
  })
})
