import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { HttpClientRequest } from "effect/http"
import { ai, LLMEvent, Message, ToolDefinition } from "../../src/effect.js"
import { AmazonBedrockMantle } from "../../src/providers.js"
import { OpenResponses } from "../../src/protocols/open-responses.js"
import { compileRequest, LLMClient } from "../../src/route/client.js"
import { it } from "../lib/effect.js"
import { withProcessEnv } from "../lib/env.js"
import { dynamicResponse, fixedResponse } from "../lib/http.js"
import { sseEvents } from "../lib/sse.js"

const credentials = {
  region: "us-east-2",
  accessKeyId: "AKIAIOSFODNN7EXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
}

describe("Amazon Bedrock Mantle provider", () => {
  it.effect("uses Responses by default and exposes Chat and Messages explicitly", () =>
    Effect.gen(function* () {
      const provider = AmazonBedrockMantle.configure({ credentials })
      expect(provider.model("openai.gpt-oss-120b").route.transport).toBe(OpenResponses.httpTransport)
      const chat = yield* compileRequest(ai.request({ model: provider.chat("openai.gpt-oss-120b"), prompt: "Hi" }))
      const messages = yield* compileRequest(
        ai.request({ model: provider.messages("anthropic.claude-opus-4-8"), prompt: "Hi", cache: "none" }),
      )
      const responses = yield* compileRequest(
        ai.request({ model: provider.model("openai.gpt-oss-120b"), prompt: "Hi" }),
      )

      expect(chat).toMatchObject({
        route: "bedrock-mantle-chat",
        protocol: "openai-chat",
        body: { model: "openai.gpt-oss-120b" },
      })
      expect(messages).toMatchObject({
        route: "bedrock-mantle-messages",
        protocol: "anthropic-messages",
        body: { model: "anthropic.claude-opus-4-8", stream: true },
      })
      expect(responses).toMatchObject({
        route: "bedrock-mantle-responses",
        protocol: "open-responses",
        body: { model: "openai.gpt-oss-120b", store: false },
      })
      expect(provider.model("openai.gpt-oss-120b").route.providerMetadataKey).toBe("mantle")
      expect(provider.chat("openai.gpt-oss-120b").route.providerMetadataKey).toBe("mantle")
      expect(provider.messages("anthropic.claude-opus-4-8").route.providerMetadataKey).toBe("mantle")
    }),
  )

  it.effect("preserves configured top-p generation defaults for Chat, Messages, and Responses", () =>
    Effect.gen(function* () {
      const settings = { apiKey: "test-key", topP: 0.8 }
      const chat = yield* compileRequest(
        ai.request({
          model: AmazonBedrockMantle.chatModel("openai.gpt-oss-safeguard-20b", settings),
          prompt: "Hi",
        }),
      )
      const messages = yield* compileRequest(
        ai.request({
          model: AmazonBedrockMantle.messagesModel("anthropic.claude-opus-4-8", settings),
          prompt: "Hi",
        }),
      )
      const responses = yield* compileRequest(
        ai.request({ model: AmazonBedrockMantle.responsesModel("openai.gpt-oss-120b", settings), prompt: "Hi" }),
      )

      expect(chat.body.top_p).toBe(0.8)
      expect(messages.body.top_p).toBe(0.8)
      expect(responses.body.top_p).toBe(0.8)
    }),
  )

  it.effect("uses the Mantle endpoint and signing service across Responses and Messages", () =>
    Effect.gen(function* () {
      const seen: Array<{ readonly url: string; readonly authorization: string | undefined }> = []
      const configured = AmazonBedrockMantle.configure({ credentials, region: "us-west-1" })
      for (const selected of [
        configured.responses("openai.gpt-oss-120b"),
        configured.messages("anthropic.claude-opus-4-8"),
      ]) {
        yield* LLMClient.generate(ai.request({ model: selected, prompt: "Hi" })).pipe(
          Effect.provide(
            dynamicResponse((input) =>
              Effect.gen(function* () {
                const request = yield* HttpClientRequest.toWeb(input.request)
                seen.push({ url: request.url, authorization: request.headers.get("authorization") ?? undefined })
                return input.respond("", { headers: { "content-type": "text/event-stream" } })
              }),
            ),
          ),
          Effect.flip,
        )
      }

      expect(seen.map((item) => item.url)).toEqual([
        "https://bedrock-mantle.us-west-1.api.aws/v1/responses",
        "https://bedrock-mantle.us-west-1.api.aws/anthropic/v1/messages",
      ])
      expect(seen.every((item) => item.authorization?.includes("/us-west-1/bedrock-mantle/aws4_request"))).toBe(true)
    }).pipe(withProcessEnv({ AWS_BEARER_TOKEN_BEDROCK: undefined })),
  )

  it.effect("applies inline cache breakpoints on Mantle Messages", () =>
    Effect.gen(function* () {
      const model = AmazonBedrockMantle.configure({ apiKey: "test-key" }).messages("anthropic.claude-opus-4-8")
      const prepared = yield* compileRequest(
        ai.request({
          model,
          system: "You are concise.",
          messages: [Message.user("Hello")],
          cache: "auto",
        }),
      )

      expect(prepared.body.system).toEqual([
        { type: "text", text: "You are concise.", cache_control: { type: "ephemeral" } },
      ])
      expect(prepared.body.messages).toEqual([
        { role: "user", content: [{ type: "text", text: "Hello", cache_control: { type: "ephemeral" } }] },
      ])
    }),
  )

  it.effect("signs with the Mantle service using default-chain credentials", () =>
    Effect.gen(function* () {
      const seen: Array<string | undefined> = []
      const model = AmazonBedrockMantle.configure({ region: "us-west-1" }).responses("openai.gpt-oss-120b")
      yield* LLMClient.generate(ai.request({ model, prompt: "Hi" })).pipe(
        Effect.provide(
          dynamicResponse((input) =>
            Effect.gen(function* () {
              const request = yield* HttpClientRequest.toWeb(input.request)
              seen.push(request.headers.get("authorization") ?? undefined)
              return input.respond("", { headers: { "content-type": "text/event-stream" } })
            }),
          ),
        ),
        Effect.flip,
      )

      expect(seen[0]).toContain("Credential=AKIACHAINEXAMPLE/")
      expect(seen[0]).toContain("/us-west-1/bedrock-mantle/aws4_request")
    }).pipe(
      withProcessEnv({
        AWS_BEARER_TOKEN_BEDROCK: undefined,
        AWS_PROFILE: undefined,
        AWS_ACCESS_KEY_ID: "AKIACHAINEXAMPLE",
        AWS_SECRET_ACCESS_KEY: "chain-secret",
        AWS_SESSION_TOKEN: undefined,
      }),
    ),
  )

  it.effect("supports bearer authentication and custom base URLs", () =>
    Effect.gen(function* () {
      const seen: Array<{ readonly url: string; readonly authorization: string | undefined }> = []
      const model = AmazonBedrockMantle.configure({
        apiKey: "test-key",
        baseURL: "https://mantle.test/v1",
      }).chat("openai.gpt-oss-safeguard-20b")
      yield* LLMClient.generate(ai.request({ model, prompt: "Hi" })).pipe(
        Effect.provide(
          dynamicResponse((input) =>
            Effect.gen(function* () {
              const request = yield* HttpClientRequest.toWeb(input.request)
              seen.push({ url: request.url, authorization: request.headers.get("authorization") ?? undefined })
              return input.respond(sseEvents({ choices: [{ delta: {}, finish_reason: "stop" }] }), {
                headers: { "content-type": "text/event-stream" },
              })
            }),
          ),
        ),
      )

      expect(seen).toEqual([{ url: "https://mantle.test/v1/chat/completions", authorization: "Bearer test-key" }])
    }),
  )

  it.effect("replays reasoning with Mantle's message-prefixed item ids", () =>
    Effect.gen(function* () {
      const model = AmazonBedrockMantle.configure({ apiKey: "test-key" }).responses("openai.gpt-oss-120b")
      const item = { type: "reasoning", id: "msg_95d4d0af4350432a", encrypted_content: "mantle-state" }
      const response = yield* LLMClient.generate(ai.request({ model, prompt: "Think." })).pipe(
        Effect.provide(
          fixedResponse(
            sseEvents(
              { type: "response.output_item.added", item },
              { type: "response.reasoning_summary_text.delta", item_id: item.id, delta: "Considering." },
              { type: "response.output_item.done", item },
              { type: "response.completed", response: { id: "resp_1" } },
            ),
          ),
        ),
      )

      const prepared = yield* compileRequest(
        ai.request({ model, messages: [response.message, Message.user("Continue.")] }),
      )

      expect(response.message.content.find((part) => part.type === "reasoning")?.providerMetadata).toEqual({
        mantle: { itemId: "msg_95d4d0af4350432a", reasoningEncryptedContent: "mantle-state" },
      })
      expect(prepared.body.input).toEqual([
        {
          type: "reasoning",
          id: "msg_95d4d0af4350432a",
          summary: [{ type: "summary_text", text: "Considering." }],
          encrypted_content: "mantle-state",
        },
        { type: "message", role: "user", content: [{ type: "input_text", text: "Continue." }] },
      ])
    }),
  )
})
