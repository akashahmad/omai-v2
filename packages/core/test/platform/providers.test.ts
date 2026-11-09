import { describe, expect, test } from "bun:test"
import { PlatformProviders } from "@opencode/core/platform/providers"

describe("PlatformProviders", () => {
  test("auth styles per package; providers without plain API keys are unsupported", () => {
    expect(PlatformProviders.auth("@ai-sdk/anthropic")).toBe("x-api-key")
    expect(PlatformProviders.auth("aisdk:@ai-sdk/anthropic")).toBe("x-api-key")
    expect(PlatformProviders.auth("@opencode/ai/providers/anthropic")).toBe("x-api-key")
    expect(PlatformProviders.auth("@ai-sdk/google")).toBe("x-goog-api-key")
    expect(PlatformProviders.auth("@opencode/ai/providers/google/interactions")).toBe("x-goog-api-key")
    expect(PlatformProviders.auth("@opencode/ai/providers/openai/responses")).toBe("bearer")
    expect(PlatformProviders.auth("@ai-sdk/openai-compatible")).toBe("bearer")
    expect(PlatformProviders.auth("@opencode/ai/providers/google-vertex/messages")).toBeUndefined()
    expect(PlatformProviders.auth("@opencode/ai/providers/amazon-bedrock")).toBeUndefined()
    expect(PlatformProviders.auth("@opencode/ai/providers/azure/chat")).toBeUndefined()
    expect(PlatformProviders.auth(undefined)).toBeUndefined()
  })

  test("a provider's API base falls back to its package's built-in address", () => {
    expect(PlatformProviders.base({ package: "@ai-sdk/openai" })).toBe("https://api.openai.com/v1")
    expect(PlatformProviders.base({ package: "@ai-sdk/anthropic" })).toBe("https://api.anthropic.com/v1")
    expect(PlatformProviders.base({ package: "@ai-sdk/google" })).toBe(
      "https://generativelanguage.googleapis.com/v1beta",
    )
    expect(PlatformProviders.base({ package: "@ai-sdk/openai", settings: { baseURL: "https://x.test/v1" } })).toBe(
      "https://x.test/v1",
    )
    expect(PlatformProviders.base({ package: "@ai-sdk/openai-compatible" })).toBeUndefined()
  })

  test("select keeps key-connected, supported providers with every base their models use", () => {
    const providers = [
      { id: "openai", package: "@ai-sdk/openai" },
      { id: "groq", package: "@ai-sdk/openai-compatible", settings: { baseURL: "https://api.groq.com/openai/v1" } },
      { id: "vertex", package: "@opencode/ai/providers/google-vertex" },
      { id: "nokey", package: "@ai-sdk/anthropic" },
      { id: "oauth", package: "@ai-sdk/openai" },
    ]
    const models = [
      { id: "gpt-eu", modelID: "gpt-5", providerID: "openai", settings: { baseURL: "https://eu.api.openai.com/v1" } },
      { id: "gpt-5", providerID: "openai" },
      { id: "llama", providerID: "groq" },
    ]
    const keys = new Map<string, { type: string; key?: string }>([
      ["openai", { type: "key", key: "sk-1" }],
      ["groq", { type: "key", key: "gsk-2" }],
      ["vertex", { type: "key", key: "v" }],
      ["oauth", { type: "oauth" }],
    ])
    expect(PlatformProviders.select({ providers, models, keys })).toEqual([
      {
        id: "openai",
        auth: "bearer",
        key: "sk-1",
        bases: ["https://api.openai.com/v1", "https://eu.api.openai.com/v1"],
        models: [
          { id: "gpt-eu", api: "gpt-5" },
          { id: "gpt-5", api: "gpt-5" },
        ],
      },
      {
        id: "groq",
        auth: "bearer",
        key: "gsk-2",
        bases: ["https://api.groq.com/openai/v1"],
        models: [{ id: "llama", api: "llama" }],
      },
    ])
  })
})
