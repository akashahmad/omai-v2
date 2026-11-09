import { describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createSharedVisibility } from "./shared-models"

const gpt5 = { providerID: "openai", modelID: "gpt-5" }
const gpt4 = { providerID: "openai", modelID: "gpt-4" }
const claude = { providerID: "anthropic", modelID: "claude-x" }
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

describe("createSharedVisibility", () => {
  test("shared models always show; the user's own switches come from their account", async () => {
    const source = createRoot(() =>
      createSharedVisibility({
        shared: async () => [gpt5],
        mine: async () => [{ ...claude, visible: false }],
        save: async () => undefined,
      }),
    )
    await tick()
    expect(source.visible(gpt5)).toBe(true)
    expect(source.visible(claude)).toBe(false)
    // Never switched: the browser's defaults decide.
    expect(source.visible(gpt4)).toBeUndefined()
  })

  test("a switch shows at once and is saved to the user's account", async () => {
    const saved: unknown[] = []
    const source = createRoot(() =>
      createSharedVisibility({
        shared: async () => [],
        mine: async () => [],
        save: async (item) => void saved.push(item),
      }),
    )
    await tick()
    source.set?.(gpt4, true)
    expect(source.visible(gpt4)).toBe(true)
    await tick()
    expect(saved).toEqual([{ ...gpt4, visible: true }])
  })
})
