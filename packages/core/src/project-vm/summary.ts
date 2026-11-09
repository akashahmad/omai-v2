export * as ProjectVmSummary from "./summary.js"

import { DateTime, Duration, Effect, Stream } from "effect"
import { Bus } from "../bus.js"
import { Session } from "../session.js"
import { SessionEvent } from "../session/event.js"

/**
 * On a project's MicroVM, tells the control plane about the latest top-level session so the projects page can show
 * it. Changes are debounced; a failed push is logged and dropped, and the next change sends again.
 */
export const start = (input: { url: string; projectID: string; token: string; debounceMs?: number }) =>
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const sessions = yield* Session.Service
    const target = `${input.url.replace(/\/+$/, "")}/internal/projects/${encodeURIComponent(input.projectID)}/summary`

    const push = (sessionID: Session.ID) =>
      Effect.gen(function* () {
        const session = yield* sessions.get(sessionID)
        if (session.parentID) return
        const body = { title: session.title ?? "New session", at: DateTime.toEpochMillis(session.time.updated) }
        const response = yield* Effect.tryPromise(() =>
          fetch(target, {
            method: "POST",
            headers: { authorization: `Bearer ${input.token}`, "content-type": "application/json" },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(10_000),
          }),
        )
        if (!response.ok) yield* Effect.logWarning(`project summary push answered ${response.status}`)
      }).pipe(Effect.catchCause((cause) => Effect.logWarning("project summary push failed", cause)))

    yield* bus.subscribe([SessionEvent.Created, SessionEvent.Renamed, SessionEvent.InboxEnqueued]).pipe(
      Stream.map((event) => event.data.sessionID),
      Stream.debounce(Duration.millis(input.debounceMs ?? 2000)),
      Stream.runForEach(push),
    )
  })
