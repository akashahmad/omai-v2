export * as OptimizePlugin from "./optimize.js"

import { define, type Context } from "@opencode/plugin/effect/plugin"
import type { SessionHooks } from "@opencode/plugin/effect/session"
import { Model } from "@opencode/schema/model"
import { Effect } from "effect"
import { SessionSystemPrompt } from "../session/system-prompt.js"

import PROMPT_GPT from "./system-prompt/gpt.txt"
import PROMPT_ASTRA from "./system-prompt/gpt-astra.txt"
import PROMPT_KIMI from "./system-prompt/kimi.txt"
import PROMPT_META from "./system-prompt/meta.txt"
import PROMPT_TRINITY from "./system-prompt/trinity.txt"
import PROMPT_ANTHROPIC from "./system-prompt/anthropic.txt"
import PROMPT_DEFAULT from "./system-prompt/default.txt"

export const OpenAIPlugin = make("omai.prompt.openai", (model) => {
  const id = model.id.toLowerCase()
  if (!id.includes("gpt")) return undefined
  return id.includes("astra") ? PROMPT_ASTRA : PROMPT_GPT
})

export const AnthropicPlugin = make(
  "omai.prompt.anthropic",
  (model) => {
    const id = model.id.toLowerCase()
    if (!id.includes("claude")) return undefined
    return PROMPT_ANTHROPIC
  },
  "append",
)

// Both OpenAIToolsPlugin and AnthropicToolsPlugin are disabled intentionally until we can figure out a good ux for displaying
// heavy grep/glob usage done via shell or other mechanisms

export const OpenAIToolsPlugin = make("omai.optimize.openai.tools", (model, tools) => {
  const ids = [model.id, model.modelID, model.family].join(" ").toLowerCase()
  if (!ids.includes("gpt")) return undefined
  delete tools.grep
  delete tools.glob
  return undefined
})

export const AnthropicToolsPlugin = make("omai.optimize.anthropic.tools", (model, tools) => {
  const ids = [model.id, model.modelID, model.family].join(" ").toLowerCase()
  if (!ids.includes("claude")) return undefined
  delete tools.grep
  delete tools.glob
  return undefined
})

export const KimiPlugin = make("omai.prompt.kimi", (model) =>
  model.id.toLowerCase().includes("kimi") ? PROMPT_KIMI : undefined,
)
export const ArceePlugin = make("omai.prompt.arcee", (model) =>
  model.id.toLowerCase().includes("trinity") ? PROMPT_TRINITY : undefined,
)
export const MetaPlugin = make("omai.prompt.meta", (model) => {
  if (!model.id.toLowerCase().includes("muse")) return undefined
  return PROMPT_META.replaceAll("{{MODEL_NAME}}", model.name)
})

// Every model without a prompt above gets this one. The baseline alone sets no scope or stopping point, so models
// such as DeepSeek kept running, testing and re-checking the app long after the requested change was made.
export const DefaultPlugin = make("omai.prompt.default", (model) => {
  const id = model.id.toLowerCase()
  const tuned = ["gpt", "claude", "kimi", "trinity", "muse"].some((name) => id.includes(name))
  return tuned ? undefined : PROMPT_DEFAULT
})

export const Plugins = [OpenAIPlugin, AnthropicPlugin, KimiPlugin, ArceePlugin, MetaPlugin, DefaultPlugin] as const

const models = new WeakMap<SessionHooks["context"], Model.Info>()

export const resolveModel = (ctx: Context, event: SessionHooks["context"]) =>
  Effect.gen(function* () {
    const cached = models.get(event)
    if (cached?.providerID === event.model.providerID && cached.id === event.model.id) return cached
    const model: Model.Info =
      (yield* ctx.model.list()).data.find(
        (model) => model.providerID === event.model.providerID && model.id === event.model.id,
      ) ?? Model.Info.default(event.model.providerID, event.model.id)
    models.set(event, model)
    return model
  })

function make(
  id: string,
  optimize: (model: Model.Info, tools: SessionHooks["context"]["tools"]) => string | undefined,
  mode: "override" | "append" = "override",
) {
  return define({
    id,
    effect: Effect.fn(`OptimizePlugin.${id}`)(function* (ctx) {
      const hook = (event: SessionHooks["context"]) =>
        Effect.gen(function* () {
          const model = yield* resolveModel(ctx, event)
          // Curate tools before rendering their guidance, including for agents with a custom system prompt.
          const template = optimize(model, event.tools)
          if (!template) return
          if ((yield* ctx.agent.get({ agentID: event.agent })).data.system) return
          const system = event.system[0]
          if (!system) return
          const rendered = SessionSystemPrompt.render(template, Object.keys(event.tools))
          const text = mode === "append" ? `${system.text}\n\n${rendered}` : rendered
          event.system[0] = { ...system, text }
        }).pipe(Effect.catch(() => Effect.void))
      yield* ctx.session.hook("context", hook)
      yield* ctx.session.hook("compaction", hook)
      yield* ctx.session.hook("generate", hook)
    }),
  })
}
