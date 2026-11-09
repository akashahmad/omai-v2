import { describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createSharedVisibility } from "./shared-models"

describe("createSharedVisibility", () => {
  test("shared models always show; everything else follows the user's own switches", async () => {
    const source = createRoot(() => createSharedVisibility(async () => [{ providerID: "openai", modelID: "gpt-5" }]))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(source.visible({ providerID: "openai", modelID: "gpt-5" })).toBe(true)
    expect(source.visible({ providerID: "openai", modelID: "gpt-4" })).toBeUndefined()
    expect(source.set).toBeUndefined()
  })
})
