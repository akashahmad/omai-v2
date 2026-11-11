import { describe, expect } from "bun:test"
import { SystemPart } from "@opencode/ai/effect"
import { Agent } from "@opencode/core/agent"
import { Plugin } from "@opencode/core/plugin"
import { PluginHooks } from "@opencode/core/plugin/hooks"
import { PluginHost } from "@opencode/core/plugin/host"
import { PreviewPlugin } from "@opencode/core/plugin/preview"
import { Provider } from "@opencode/core/provider"
import { Session } from "@opencode/core/session"
import type { SessionHooks } from "@opencode/plugin/effect/session"
import { Model } from "@opencode/schema/model"
import { Effect } from "effect"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "./fixture"

const it = testEffect(PluginTestLayer)

const context = (agent: string): SessionHooks["context"] => ({
  sessionID: Session.ID.make("ses_preview_guidance"),
  agent: Agent.ID.make(agent),
  model: Model.Ref.make({ providerID: Provider.ID.make("test"), id: Model.ID.make("deepseek-v4-flash") }),
  system: [SystemPart.make("Base prompt")],
  messages: [],
  tools: {},
  options: {},
})

describe("PreviewPlugin.GuidancePlugin", () => {
  it.effect("tells the agent the preview runs by itself, so it does not start or check the app", () =>
    Effect.gen(function* () {
      const agents = yield* Agent.Service
      const plugins = yield* Plugin.Service
      const hooks = yield* PluginHooks.Service
      yield* agents.transform((editor) => editor.update(Agent.ID.make("build"), () => {}))
      yield* PreviewPlugin.GuidancePlugin.effect(yield* PluginHost.make(plugins, "test"))
      const event = context("build")

      yield* hooks.trigger("session", "context", event)

      expect(event.system.map((part) => part.text)).toEqual(["Base prompt", PreviewPlugin.GUIDANCE])
      expect(PreviewPlugin.GUIDANCE).toContain("Do not start a dev server")
      expect(PreviewPlugin.GUIDANCE).toContain("When the requested change is made, stop")
    }),
  )

  it.effect("leaves agents with their own system prompt alone", () =>
    Effect.gen(function* () {
      const agents = yield* Agent.Service
      const plugins = yield* Plugin.Service
      const hooks = yield* PluginHooks.Service
      yield* agents.transform((editor) =>
        editor.update(Agent.ID.make("preview-setup"), (agent) => {
          agent.system = "Setup prompt"
        }),
      )
      yield* PreviewPlugin.GuidancePlugin.effect(yield* PluginHost.make(plugins, "test"))
      const event = context("preview-setup")

      yield* hooks.trigger("session", "context", event)

      expect(event.system.map((part) => part.text)).toEqual(["Base prompt"])
    }),
  )
})
