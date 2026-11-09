import { describe, expect } from "bun:test"
import { createServer } from "node:http"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Database } from "@opencode/core/database/database"
import { Bus } from "@opencode/core/bus"
import { Instance } from "@opencode/core/instance/service"
import { Location } from "@opencode/core/location"
import { Project } from "@opencode/core/project"
import { ProjectVmSummary } from "@opencode/core/project-vm/summary"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { SessionExecution } from "@opencode/core/session/execution"
import { SessionModelTransport } from "@opencode/core/session/model-transport"
import { SessionProjector } from "@opencode/core/session/projector"
import { SessionStore } from "@opencode/core/session/store"
import { SessionEnvironment } from "@opencode/core/session/environment"
import { LocationServiceMap } from "@opencode/core/location-services"
import { it } from "../lib/effect"
import { globalProjectNode } from "../lib/project"
import { offlineModels } from "../fixture/models"
import { tmpdirScoped } from "../fixture/tmpdir"

type Received = { url: string; authorization: string; body: { title: string; at: number } }

/** A real HTTP receiver standing in for the control plane's internal summary route. */
const receiver = Effect.acquireRelease(
  Effect.promise(
    () =>
      new Promise<{ url: string; received: Received[]; close: () => void }>((resolve) => {
        const received: Received[] = []
        const server = createServer((req, res) => {
          const chunks: Buffer[] = []
          req.on("data", (chunk: Buffer) => chunks.push(chunk))
          req.on("end", () => {
            received.push({
              url: req.url ?? "",
              authorization: req.headers.authorization ?? "",
              body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
            })
            res.statusCode = 204
            res.end()
          })
        })
        server.listen(0, "127.0.0.1", () => {
          const address = server.address()
          const port = typeof address === "object" && address ? address.port : 0
          resolve({ url: `http://127.0.0.1:${port}`, received, close: () => server.close() })
        })
      }),
  ),
  (server) => Effect.sync(() => server.close()),
)

describe("ProjectVmSummary", () => {
  it.live("posts the latest session title", () =>
    Effect.gen(function* () {
      const control = yield* receiver
      const session = yield* Session.Service
      const directory = yield* tmpdirScoped()
      yield* ProjectVmSummary.start({ url: control.url, projectID: "p1", token: "secret", debounceMs: 200 }).pipe(
        Effect.forkScoped({ startImmediately: true }),
      )
      // Let the subscription start before the first event.
      yield* Effect.sleep("50 millis")
      const location = Location.Ref.make({ directory: AbsolutePath.make(directory.path) })
      const created = yield* session.create({ location })
      yield* session.rename({ sessionID: created.id, title: "Checkout page" })
      yield* Effect.sleep("700 millis")

      expect(control.received).toHaveLength(1)
      expect(control.received[0]?.url).toBe("/internal/projects/p1/summary")
      expect(control.received[0]?.authorization).toBe("Bearer secret")
      expect(control.received[0]?.body.title).toBe("Checkout page")
      expect(typeof control.received[0]?.body.at).toBe("number")
    }).pipe(Effect.provide(layer)),
  )
})

const transport = Layer.succeed(
  SessionModelTransport.Service,
  SessionModelTransport.Service.of({
    bind: () => ({ execute: () => Effect.die("Unexpected WebSocket execution") }),
    close: () => Effect.void,
    closeAll: Effect.void,
  }),
)

const layer = AppNodeBuilder.build(
  LayerNode.group([
    Database.node,
    Bus.node,
    SessionProjector.node,
    SessionStore.node,
    SessionEnvironment.node,
    Session.node,
    Instance.node,
    LocationServiceMap.node,
  ]),
  [
    Project.node.replace(globalProjectNode),
    SessionExecution.node.replace(SessionExecution.noopLayer),
    SessionModelTransport.node.replace(transport),
    offlineModels,
  ],
)
