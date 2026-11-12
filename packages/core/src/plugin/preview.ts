export * as PreviewPlugin from "./preview.js"

import { SystemPart } from "@opencode/ai/effect"
import { define } from "@opencode/plugin/effect/plugin"
import type { SessionHooks } from "@opencode/plugin/effect/session"
import { Agent } from "@opencode/schema/agent"
import { Audit } from "@opencode/schema/audit"
import { Preview } from "@opencode/schema/preview"
import { Session } from "@opencode/schema/session"
import { Effect, Schema } from "effect"
import { findChrome } from "../audit/chrome.js"
import { createAuditor } from "../audit/service.js"
import { capturePage } from "../preview/capture.js"
import { createController, type Store } from "../preview/controller.js"
import { createFixer } from "../preview/fix.js"
import { PreviewOrigin } from "../preview/origin.js"
import { PublishRemote } from "../publish/remote.js"
import { AI_STEPS } from "../preview/limits.js"
import { PreviewThumbnail } from "../preview/thumbnail.js"
import SETUP from "./preview/setup.txt"

const SETUP_AGENT = Agent.ID.make("preview-setup")

const TOOL = "preview_try"

// Without this, agents start their own dev server to check their work and loop on run, test and fix.
export const GUIDANCE = [
  "# App preview",
  "O M A I + runs this project's web preview by itself and shows it to the user next to the chat; it picks up your file changes on its own.",
  "- Do not start a dev server, or open the app with curl or a browser to verify your work, unless the user asks you to.",
  "- When the requested change is made, stop and reply with a short summary.",
].join("\n")

const TryInput = Schema.Struct({
  root: Schema.String.annotate({
    description: 'The app directory, relative to the project. "." is the project itself.',
  }),
  kind: Schema.optionalKey(Schema.Literals(["command", "static"])).annotate({
    description: '"static" serves the directory as plain files. Defaults to "command".',
  }),
  install: Schema.optionalKey(Schema.String).annotate({
    description: "A command that installs packages before the start, when they need installing.",
  }),
  command: Schema.optionalKey(Schema.String).annotate({
    description: 'The start command. Write "{port}" where the port goes.',
  }),
  port: Schema.optionalKey(Schema.Number).annotate({
    description: "A port the command always uses, when it can't take {port}.",
  }),
})

const TryOutput = Schema.Struct({ ok: Schema.Boolean, reason: Schema.String, log: Schema.String })

// Agents with their own system prompt (preview setup, compaction, titles) do their own narrow job and skip it.
export const GuidancePlugin = define({
  id: "omai.preview.guidance",
  effect: Effect.fn("PreviewPlugin.guidance")(function* (ctx) {
    yield* ctx.session.hook("context", (event: SessionHooks["context"]) =>
      Effect.gen(function* () {
        if ((yield* ctx.agent.get({ agentID: event.agent })).data.system) return
        event.system.push(SystemPart.make(GUIDANCE))
      }).pipe(Effect.catch(() => Effect.void)),
    )
  }),
})

export const Plugin = define({
  id: "omai.preview",
  effect: Effect.fn(function* (ctx) {
    const run = <A>(effect: Effect.Effect<A, unknown>) => Effect.runPromise(effect)
    const thumbnails = yield* PreviewThumbnail.Service
    // Plugin storage is shared by every project, so each key carries this location's directory: one project's
    // recipe, port or fix never applies to another.
    const scoped = (key: string) => `${ctx.location.directory}#${key}`
    const store: Store = {
      get: (key) => run(ctx.storage.get(scoped(key))),
      set: (key, value) =>
        run(
          value === undefined ? ctx.storage.remove(scoped(key)) : ctx.storage.set(scoped(key), value as Schema.Json),
        ),
    }

    // The setup agent runs in a child of the session that opened the preview, so it stays out of the session list.
    const fixer = createFixer({
      directory: ctx.location.directory,
      sessions: {
        create: async (parentID) => {
          const parent = await run(ctx.session.get({ sessionID: Session.ID.make(parentID) })).catch(() => undefined)
          const child = await run(
            ctx.session.create({
              parentID: Session.ID.make(parentID),
              agent: SETUP_AGENT,
              model: parent?.model,
              title: "Preview setup",
            }),
          )

          return child.id
        },
        prompt: async (sessionID, text) => {
          await run(ctx.session.prompt({ sessionID: Session.ID.make(sessionID), text }))
        },
        wait: async (sessionID) => {
          await run(ctx.session.wait({ sessionID: Session.ID.make(sessionID) }))
        },
        interrupt: async (sessionID) => {
          await run(ctx.session.interrupt({ sessionID: Session.ID.make(sessionID) }))
        },
        lastText: async (sessionID) => {
          const messages = await run(ctx.session.context({ sessionID: Session.ID.make(sessionID) }))
          const last = messages.findLast((message) => message.type === "assistant")

          return last?.type === "assistant"
            ? last.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n")
            : undefined
        },
      },
    })

    yield* ctx.agent.transform((editor) => {
      // Every other agent is denied the tool, which also keeps it out of their tool lists.
      editor
        .list()
        .filter((agent) => agent.id !== SETUP_AGENT)
        .forEach((agent) =>
          editor.update(agent.id, (item) => item.permissions.push({ action: TOOL, resource: "*", effect: "deny" })),
        )
      editor.update(SETUP_AGENT, (item) => {
        item.name = Agent.Name.make("Preview setup")
        item.description = "Finds the command that starts a project's preview when O M A I + can't by itself."
        item.mode = "subagent"
        item.hidden = true
        item.system = SETUP
        item.steps = AI_STEPS
        item.permissions.push(
          { action: "*", resource: "*", effect: "deny" },
          { action: "read", resource: "*", effect: "allow" },
          { action: "glob", resource: "*", effect: "allow" },
          { action: "grep", resource: "*", effect: "allow" },
          { action: TOOL, resource: "*", effect: "allow" },
        )
      })
    })

    yield* ctx.tool.transform((editor) =>
      editor.add({
        name: TOOL,
        options: { codemode: false },
        description:
          "Installs and starts a project's preview with the given recipe and reports whether the dev server came up, with the end of its log.",
        input: TryInput,
        output: TryOutput,
        execute: (input, context) =>
          Effect.promise(() =>
            fixer.tryRecipe(context.sessionID, {
              root: input.root,
              kind: input.kind ?? "command",
              install: input.install,
              command: input.command,
              port: input.port,
              source: "ai",
            }),
          ).pipe(
            Effect.map((result) => ({
              output: result,
              content: result.ok
                ? "The preview is running. Stop now."
                : [`It didn't start: ${result.reason}`, result.log && `\nThe end of the log:\n${result.log}`]
                    .filter(Boolean)
                    .join("\n"),
            })),
          ),
      }),
    )

    // The events need the registration, which needs the handlers; the controller reads it once it publishes.
    const publish: { current?: (name: "changed" | "log", value: unknown) => void } = {}
    // On a hosted project VM: the preview listens on the port the VM publishes, under the address the control plane
    // knows. A local VM publishes no port and has no public address; its preview is reached on its own port.
    const fixedPort = Number(process.env.OMAI_PREVIEW_PORT)
    const published = Number.isInteger(fixedPort) && fixedPort > 0
    const remote = published ? PublishRemote.target(process.env) : undefined
    // The panel only hears status changes, so the status goes out again once the address is known.
    const origin = remote
      ? PreviewOrigin.poll(remote, {
          onKnown: () => publish.current?.("changed", { ...controller.status(), directory: ctx.location.directory }),
        })
      : undefined
    if (origin) yield* Effect.addFinalizer(() => Effect.sync(() => origin.close()))
    const controller = createController({
      directory: ctx.location.directory,
      // The server publishes where it listens and whether it has a password when it starts (see ServerProcess).
      hostname: process.env.OMAI_PREVIEW_HOSTNAME || "127.0.0.1",
      auth: process.env.OMAI_PREVIEW_AUTH === "1",
      port: published ? fixedPort : undefined,
      origin: origin?.get,
      store,
      config: () => undefined,
      fix: fixer.fix,
      // The projects page shows the latest screenshot of each project's app, also while its preview is stopped.
      thumbnail: {
        capture: async (url) => {
          const chrome = findChrome()

          if (!chrome) return
          const image = await capturePage({ chrome, url })
          await run(thumbnails.save(ctx.location.project.id, image))
        },
      },
      emit: {
        changed: (status) => publish.current?.("changed", { ...status, directory: ctx.location.directory }),
        log: (chunk) => publish.current?.("log", { chunk, directory: ctx.location.directory }),
      },
    })
    yield* Effect.addFinalizer(() => Effect.promise(() => controller.close()))

    const rpc = yield* ctx.rpc
      .register(Preview.Definition, {
        status: () => Effect.sync(() => ({ ...controller.status(), directory: ctx.location.directory })),
        start: (input) => Effect.promise(() => controller.start(input)),
        stop: () => Effect.promise(() => controller.stop()),
        restart: () => Effect.promise(() => controller.restart()),
        setRecipe: (input) => Effect.promise(() => controller.setRecipe(input.recipe)),
        logs: () => Effect.sync(() => ({ text: controller.logs() })),
        ticket: () => Effect.sync(() => ({ ticket: controller.ticket() })),
        watch: () => Effect.sync(() => (controller.watch(), {})),
        asset: (input, context) =>
          Effect.tryPromise({
            try: () => controller.asset(input),
            catch: (error) => context.error("preview.asset", reason(error), {}),
          }),
      })
      .pipe(Effect.orDie)

    // The website audit measures the preview's dev server directly, so it lives with the preview.
    const audits: { emit?: (status: Audit.Status) => void } = {}
    const auditor = createAuditor({
      directory: ctx.location.directory,
      store,
      preview: async () => {
        if (controller.status().state !== "running") await controller.start()
        controller.watch()
        const port = controller.upstream()

        if (!port) throw new Error("The preview isn't running, so there is nothing to audit yet.")

        return `http://127.0.0.1:${port}/`
      },
      emit: (status) => audits.emit?.(status),
    })
    yield* Effect.addFinalizer(() => Effect.sync(() => auditor.close()))

    const auditRpc = yield* ctx.rpc
      .register(Audit.Definition, {
        status: () => Effect.promise(() => auditor.status()),
        run: (input, context) =>
          Effect.tryPromise({ try: () => auditor.run(input), catch: (error) => context.error("audit.failed", reason(error), {}) }),
        cancel: () => Effect.promise(() => auditor.cancel()),
        open: (input, context) =>
          Effect.tryPromise({ try: () => auditor.open(input.id), catch: (error) => context.error("audit.failed", reason(error), {}) }),
        archive: (input) => Effect.promise(() => auditor.archive(input.id, input.archived)),
        remove: (input) => Effect.promise(() => auditor.remove(input.id)),
        pdf: (input, context) =>
          Effect.tryPromise({ try: () => auditor.pdf(input.html), catch: (error) => context.error("audit.failed", reason(error), {}) }),
      })
      .pipe(Effect.orDie)
    audits.emit = (status) =>
      void Effect.runFork(auditRpc.events.emit("changed", status).pipe(Effect.catchCause(() => Effect.void)))

    publish.current = (name, value) =>
      void Effect.runFork(
        (name === "changed"
          ? rpc.events.emit("changed", value as Preview.Status)
          : rpc.events.emit("log", value as { chunk: string; directory: string })
        ).pipe(Effect.catchCause(() => Effect.void)),
      )
  }),
})

const reason = (error: unknown) => (error instanceof Error ? error.message : "The audit failed.")
