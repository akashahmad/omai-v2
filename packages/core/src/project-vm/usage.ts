export * as ProjectVmUsage from "./usage.js"

import { Duration, Effect, Schedule, Stream } from "effect"
import { Bus } from "../bus.js"
import { SessionEvent } from "../session/event.js"

export type Step = { providerID: string; modelID: string; inputTokens: number; outputTokens: number; at: number }

const FLUSH = Duration.seconds(10)

/**
 * Model usage per AI step, waiting to be reported: a step's model comes from its start, its tokens from its end. At
 * most `limit` wait while the control plane is unreachable; the oldest go first.
 */
export function create(input: { limit: number }) {
  const models = new Map<string, { providerID: string; id: string }>()
  const queue: Step[] = []
  const trim = () => queue.splice(0, Math.max(0, queue.length - input.limit))

  return {
    started(event: { assistantMessageID: string; model: { providerID: string; id: string } }) {
      models.set(event.assistantMessageID, { providerID: event.model.providerID, id: event.model.id })
    },
    ended(event: { assistantMessageID: string; tokens: { input: number; output: number } }, at: number) {
      const model = models.get(event.assistantMessageID)
      models.delete(event.assistantMessageID)
      if (!model) return
      queue.push({
        providerID: model.providerID,
        modelID: model.id,
        inputTokens: event.tokens.input,
        outputTokens: event.tokens.output,
        at,
      })
      trim()
    },
    take: () => queue.splice(0, queue.length),
    restore(steps: Step[]) {
      queue.unshift(...steps)
      trim()
    },
  }
}

/** On a project's MicroVM: reports each AI step's tokens to the control plane, every 10 s. */
export const start = (target: { url: string; projectID: string; token: string }) =>
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const usage = create({ limit: 1000 })
    const url = `${target.url}/internal/projects/${encodeURIComponent(target.projectID)}/usage`
    const flush = Effect.promise(async () => {
      const steps = usage.take()
      if (steps.length === 0) return
      for (const batch of chunks(steps, 200)) {
        const ok = await fetch(url, {
          method: "POST",
          headers: { authorization: `Bearer ${target.token}`, "content-type": "application/json" },
          body: JSON.stringify({ steps: batch }),
          signal: AbortSignal.timeout(10_000),
        }).then(
          (res) => res.ok,
          () => false,
        )
        if (!ok) return usage.restore(steps.slice(steps.indexOf(batch[0]!)))
      }
    })
    yield* flush.pipe(Effect.repeat(Schedule.spaced(FLUSH)), Effect.forkScoped({ startImmediately: true }))
    yield* bus.subscribe([SessionEvent.Step.Started, SessionEvent.Step.Ended]).pipe(
      Stream.runForEach((event) =>
        Effect.sync(() => {
          if (event.type === SessionEvent.Step.Started.type) return usage.started(event.data)
          usage.ended(event.data, Date.now())
        }),
      ),
    )
  })

function chunks<A>(items: A[], size: number) {
  return Array.from({ length: Math.ceil(items.length / size) }, (_, index) =>
    items.slice(index * size, (index + 1) * size),
  )
}
