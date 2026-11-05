import { afterAll, beforeAll, expect } from "bun:test"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Location } from "@opencode/core/location"
import { Project } from "@opencode/core/project"
import { PublishPlugin } from "@opencode/core/plugin/publish"
import { Rpc } from "@opencode/core/rpc"
import { AbsolutePath } from "@opencode/core/schema"
import { Publish } from "@opencode/schema/publish"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Effect, Layer } from "effect"
import { PublishDomains } from "../../src/publish/domains"
import { PublishService } from "../../src/publish/service"
import { location } from "../fixture/location"
import { tmpdir } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"
import { host } from "./host"

const saved = { ...process.env }
let dir: Awaited<ReturnType<typeof tmpdir>>

beforeAll(async () => {
  dir = await tmpdir("omai-publish-plugin-")
  Object.keys(process.env)
    .filter((key) => key.startsWith("OMAI_CLOUDFLARE_"))
    .forEach((key) => delete process.env[key])
})

afterAll(async () => {
  Object.assign(process.env, saved)
  await dir[Symbol.asyncDispose]()
})

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Rpc.node, PublishService.node, PublishDomains.node]), [
    Location.node.replace(
      Layer.effect(
        Location.Service,
        Effect.sync(() => Location.Service.of(location(Location.Ref.make({ directory: AbsolutePath.make(dir.path) })))),
      ),
    ),
  ]),
)

const serve = Effect.gen(function* () {
  const rpc = yield* Rpc.Service
  yield* PublishPlugin.Plugin.effect(
    host({
      location: new Location.Info({
        directory: AbsolutePath.make(dir.path),
        project: {
          id: Project.ID.global,
          directory: AbsolutePath.make(dir.path),
          canonical: AbsolutePath.make(dir.path),
        },
      }),
      rpc: Object.assign(rpc.client, { register: rpc.register }),
    }),
  )
  return rpc
})

it.live("status reports not configured without credentials", () =>
  Effect.gen(function* () {
    const rpc = yield* serve
    expect((yield* rpc.client(Publish.Definition).status({})).configured).toBe(false)
    expect((yield* rpc.client(Publish.DomainsDefinition).list({})).configured).toBe(false)
  }),
)

it.live("publish fails with not-configured without credentials", () =>
  Effect.gen(function* () {
    const rpc = yield* serve
    const failure = yield* rpc.client(Publish.Definition).publish({ name: "demo" }).pipe(Effect.flip)
    expect(failure).toMatchObject({ type: "publish.failed", data: { kind: "not-configured" } })
    const domain = yield* rpc.client(Publish.DomainsDefinition).add({ hostname: "example.com" }).pipe(Effect.flip)
    expect(domain).toMatchObject({ type: "publish.failed", data: { kind: "not-configured" } })
  }),
)
