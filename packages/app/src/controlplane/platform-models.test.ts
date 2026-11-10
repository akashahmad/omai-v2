import { describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createPlatformVisibility } from "./platform-models"

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

describe("createPlatformVisibility", () => {
  test("starts from the saved switches, defaults off, and saves the whole list in order", async () => {
    const saved: { providerID: string; modelID: string }[][] = []
    const source = await new Promise<ReturnType<typeof createPlatformVisibility>>((resolve) =>
      createRoot(() =>
        resolve(
          createPlatformVisibility({
            load: async () => [{ providerID: "openai", modelID: "gpt-5" }],
            save: async (models) => void saved.push(models),
          }),
        ),
      ),
    )
    await flush()
    expect(source.visible({ providerID: "openai", modelID: "gpt-5" })).toBe(true)
    expect(source.visible({ providerID: "openai", modelID: "gpt-4" })).toBe(false)
    source.set({ providerID: "openai", modelID: "gpt-4" }, true)
    source.set({ providerID: "openai", modelID: "gpt-5" }, false)
    await flush()
    expect(source.visible({ providerID: "openai", modelID: "gpt-4" })).toBe(true)
    expect(source.visible({ providerID: "openai", modelID: "gpt-5" })).toBe(false)
    expect(saved).toEqual([
      [
        { providerID: "openai", modelID: "gpt-5" },
        { providerID: "openai", modelID: "gpt-4" },
      ],
      [{ providerID: "openai", modelID: "gpt-4" }],
    ])
  })

  test("a switch flipped before the saved list loads, or after it failed, saves nothing", async () => {
    const saved: unknown[] = []
    const gate = { open: () => {} }
    const loading = new Promise<{ providerID: string; modelID: string }[]>((resolve) => {
      gate.open = () => resolve([{ providerID: "openai", modelID: "gpt-5" }])
    })
    const source = createRoot(() =>
      createPlatformVisibility({ load: () => loading, save: async (models) => void saved.push(models) }),
    )
    source.set({ providerID: "openai", modelID: "gpt-4" }, true)
    await flush()
    expect(saved).toEqual([])
    expect(source.visible({ providerID: "openai", modelID: "gpt-4" })).toBe(false)
    gate.open()
    await flush()
    expect(source.visible({ providerID: "openai", modelID: "gpt-5" })).toBe(true)

    const failed = createRoot(() =>
      createPlatformVisibility({
        load: () => Promise.reject(new Error("down")),
        save: async (models) => void saved.push(models),
      }),
    )
    await flush()
    failed.set({ providerID: "openai", modelID: "gpt-4" }, true)
    await flush()
    expect(saved).toEqual([])
  })

  test("a platform server still starting is asked again, and the admin hears when it never answers", async () => {
    const failures: string[] = []
    const calls = { count: 0 }

    const source = createRoot(() =>
      createPlatformVisibility({
        load: async () => {
          calls.count += 1

          if (calls.count < 3) throw new Error("starting")

          return [{ providerID: "openai", modelID: "gpt-5" }]
        },
        save: async () => undefined,
        failed: (kind) => void failures.push(kind),
        retryMs: 1,
      }),
    )

    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(source.visible({ providerID: "openai", modelID: "gpt-5" })).toBe(true)
    expect(failures).toEqual([])

    createRoot(() =>
      createPlatformVisibility({
        load: () => Promise.reject(new Error("down")),
        save: async () => undefined,
        failed: (kind) => void failures.push(kind),
        retryMs: 1,
      }),
    )
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(failures).toEqual(["load"])
  })

  test("a switch that fails to save is reported and the saved list shows again", async () => {
    const failures: string[] = []

    const source = createRoot(() =>
      createPlatformVisibility({
        load: async () => [{ providerID: "openai", modelID: "gpt-5" }],
        save: () => Promise.reject(new Error("offline")),
        failed: (kind) => void failures.push(kind),
        retryMs: 1,
      }),
    )

    await flush()
    source.set({ providerID: "openai", modelID: "gpt-4" }, true)
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(failures).toEqual(["save"])
    expect(source.visible({ providerID: "openai", modelID: "gpt-4" })).toBe(false)
    expect(source.visible({ providerID: "openai", modelID: "gpt-5" })).toBe(true)
  })
})
