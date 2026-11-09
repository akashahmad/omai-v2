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

  test("select shares key and sign-in providers with the hosts their models use", () => {
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
        hosts: ["api.openai.com", "eu.api.openai.com", "chatgpt.com"],
        models: [
          { id: "gpt-eu", api: "gpt-5" },
          { id: "gpt-5", api: "gpt-5" },
        ],
      },
      {
        id: "groq",
        integrationID: "groq",
        value: { type: "key", key: "gsk-2" },
        hosts: ["api.groq.com"],
        models: [{ id: "llama", api: "llama" }],
      },
      {
        id: "copilot",
        integrationID: "github-copilot",
        value: signIn,
        hosts: [
          "api.githubcopilot.com",
          "api.github.com",
          "api.individual.githubcopilot.com",
          "api.business.githubcopilot.com",
          "api.enterprise.githubcopilot.com",
        ],
        models: [{ id: "c", api: "c" }],
      },
    ])
  })

  test("hosts by integration cover every shareable provider, merged per integration", () => {
    const providers = [
      { id: "openai", package: "@ai-sdk/openai" },
      {
        id: "openai-eu",
        integrationID: "openai",
        package: "@ai-sdk/openai",
        settings: { baseURL: "https://eu.api.openai.com/v1" },
      },
      { id: "vertex", package: "@opencode/ai/providers/google-vertex" },
    ]
    expect(PlatformProviders.hostsByIntegration({ providers, models: [], credentials: new Map() })).toEqual({
      openai: ["api.openai.com", "chatgpt.com", "eu.api.openai.com"],
    })
  })
})
