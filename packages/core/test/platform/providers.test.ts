import { describe, expect, test } from "bun:test"
import { Credential } from "@opencode/core/credential"
import { Integration } from "@opencode/core/integration"
import { PlatformProviders } from "@opencode/core/platform/providers"

describe("PlatformProviders", () => {
  test("only packages that sign requests themselves or run a local tool can't be shared", () => {
    expect(PlatformProviders.shareable("@ai-sdk/anthropic")).toBe(true)
    expect(PlatformProviders.shareable("@opencode/ai/providers/openai/responses")).toBe(true)
    expect(PlatformProviders.shareable("@ai-sdk/openai-compatible")).toBe(true)
    expect(PlatformProviders.shareable("@opencode/ai/providers/github-copilot")).toBe(true)
    expect(PlatformProviders.shareable("@opencode/ai/providers/google-vertex/messages")).toBe(false)
    expect(PlatformProviders.shareable("@opencode/ai/providers/amazon-bedrock")).toBe(false)
    expect(PlatformProviders.shareable("@opencode/ai/providers/claude-agent")).toBe(false)
    expect(PlatformProviders.shareable(undefined)).toBe(false)
  })

  test("select shares key and sign-in providers that can be shared, with their models", () => {
    const providers = [
      { id: "openai", integrationID: "openai", package: "@ai-sdk/openai" },
      { id: "groq", package: "@ai-sdk/openai-compatible", settings: { baseURL: "https://api.groq.com/openai/v1" } },
      { id: "vertex", package: "@opencode/ai/providers/google-vertex" },
      { id: "nokey", package: "@ai-sdk/anthropic" },
      {
        id: "copilot",
        integrationID: "github-copilot",
        package: "@opencode/ai/providers/github-copilot",
        settings: { baseURL: "https://api.githubcopilot.com" },
      },
    ]
    const models = [
      { id: "gpt-eu", modelID: "gpt-5", providerID: "openai", settings: { baseURL: "https://eu.api.openai.com/v1" } },
      { id: "gpt-5", providerID: "openai" },
      { id: "llama", providerID: "groq" },
      { id: "c", providerID: "copilot" },
    ]
    const signIn: Credential.Value = {
      type: "oauth",
      methodID: Integration.MethodID.make("m"),
      access: "at",
      refresh: "rt",
      expires: 1,
    }
    const credentials = new Map<string, Credential.Value>([
      ["openai", { type: "key", key: "sk-1" }],
      ["groq", { type: "key", key: "gsk-2" }],
      ["vertex", { type: "key", key: "v" }],
      ["copilot", signIn],
    ])
    expect(PlatformProviders.select({ providers, models, credentials })).toEqual([
      {
        id: "openai",
        integrationID: "openai",
        value: { type: "key", key: "sk-1" },
        models: [
          { id: "gpt-eu", api: "gpt-5" },
          { id: "gpt-5", api: "gpt-5" },
        ],
      },
      {
        id: "groq",
        integrationID: "groq",
        value: { type: "key", key: "gsk-2" },
        models: [{ id: "llama", api: "llama" }],
      },
      {
        id: "copilot",
        integrationID: "github-copilot",
        value: signIn,
        models: [{ id: "c", api: "c" }],
      },
    ])
  })
})
