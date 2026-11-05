import { afterAll, beforeAll, expect } from "bun:test"
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises"
import path from "node:path"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Location } from "@opencode/core/location"
import { Project } from "@opencode/core/project"
import { FilesPlugin } from "@opencode/core/plugin/files"
import { Rpc } from "@opencode/core/rpc"
import { AbsolutePath } from "@opencode/core/schema"
import { Files } from "@opencode/schema/files"
import { Global } from "@opencode/util/global"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Effect, Layer, Schedule } from "effect"
import { location } from "../fixture/location"
import { tmpdir } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"
import { host } from "./host"

let dir: Awaited<ReturnType<typeof tmpdir>>
let outside: Awaited<ReturnType<typeof tmpdir>>
const root = () => path.join(dir.path, "site")

beforeAll(async () => {
  dir = await tmpdir("omai-files-plugin-")
  outside = await tmpdir("omai-files-outside-")
  await mkdir(path.join(root(), "src"), { recursive: true })
  await writeFile(path.join(root(), "src/a.ts"), "export const a = 1\n")
  await writeFile(path.join(root(), "README.md"), "# Site\n".repeat(1000))
  await writeFile(path.join(outside.path, "secret.txt"), "secret")
  await symlink(outside.path, path.join(root(), "escape"))
})

afterAll(async () => {
  await dir[Symbol.asyncDispose]()
  await outside[Symbol.asyncDispose]()
})

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Rpc.node, Global.node]), [
    Location.node.replace(
      Layer.effect(
        Location.Service,
        Effect.sync(() => Location.Service.of(location(Location.Ref.make({ directory: AbsolutePath.make(root()) })))),
      ),
    ),
  ]),
)

const serve = Effect.gen(function* () {
  const rpc = yield* Rpc.Service
  yield* FilesPlugin.Plugin.effect(
    host({
      location: new Location.Info({
        directory: AbsolutePath.make(root()),
        project: { id: Project.ID.global, directory: AbsolutePath.make(root()), canonical: AbsolutePath.make(root()) },
      }),
      rpc: Object.assign(rpc.client, { register: rpc.register }),
    }),
  )
  return rpc.client(Files.Definition)
})

it.live("rename moves inside the project and never overwrites", () =>
  Effect.gen(function* () {
    const files = yield* serve
    yield* files.rename({ from: "src/a.ts", to: "src/b.ts" })
    expect(yield* Effect.promise(() => readFile(path.join(root(), "src/b.ts"), "utf8"))).toContain("a = 1")
    const exists = yield* files.rename({ from: "src/b.ts", to: "README.md" }).pipe(Effect.flip)
    expect(exists).toMatchObject({ type: "files.failed", data: { kind: "exists" } })
    yield* files.rename({ from: "src/b.ts", to: "src/a.ts" })
  }),
)

it.live("rename, remove and read refuse paths outside the project", () =>
  Effect.gen(function* () {
    const files = yield* serve
    for (const failure of [
      files.rename({ from: "README.md", to: "../README.md" }),
      files.rename({ from: "README.md", to: "escape/README.md" }),
      files.remove({ path: "" }),
      files.remove({ path: ".git" }),
      files.remove({ path: "../site" }),
      files.read({ path: "escape/secret.txt", offset: 0 }),
    ]) {
      expect(yield* failure.pipe(Effect.flip)).toMatchObject({ type: "files.failed" })
    }
    expect(yield* files.remove({ path: "missing.txt" }).pipe(Effect.flip)).toMatchObject({ data: { kind: "not-found" } })
  }),
)

it.live("remove deletes a symlink without touching its target", () =>
  Effect.gen(function* () {
    const files = yield* serve
    yield* Effect.promise(() => symlink(outside.path, path.join(root(), "escape2")))
    yield* files.remove({ path: "escape2" })
    expect(yield* Effect.promise(() => readFile(path.join(outside.path, "secret.txt"), "utf8"))).toBe("secret")
  }),
)

it.live("archive builds a zip that reads back in chunks, then release deletes it", () =>
  Effect.gen(function* () {
    const files = yield* serve
    const started = yield* files.archive({})
    expect(started).toMatchObject({ name: "site.zip", path: "" })
    // A second request while building joins the first.
    const joined = yield* files.archive({})
    expect(joined.id === started.id || joined.state === "ready").toBe(true)

    const read = (offset: number) => files.read({ id: started.id, offset })
    // The zip builds in the background; reads fail until it is ready.
    const first = yield* read(0).pipe(Effect.retry({ times: 200, schedule: Schedule.spaced("20 millis") }))
    const parts = [Buffer.from(first.data, "base64")]
    while (parts.reduce((sum, part) => sum + part.byteLength, 0) < first.size) {
      parts.push(Buffer.from((yield* read(parts.reduce((sum, part) => sum + part.byteLength, 0))).data, "base64"))
    }
    const zip = Buffer.concat(parts)
    expect(zip.byteLength).toBe(first.size)
    expect(zip.readUInt32LE(0)).toBe(0x04034b50)
    expect(zip.includes(Buffer.from("site/src/a.ts"))).toBe(true)
    expect(zip.includes(Buffer.from("secret"))).toBe(false)

    yield* files.release({ id: started.id })
    expect(yield* read(0).pipe(Effect.flip)).toMatchObject({ data: { kind: "not-found" } })
  }),
)

it.live("read returns a project file", () =>
  Effect.gen(function* () {
    const files = yield* serve
    const chunk = yield* files.read({ path: "src/a.ts", offset: 0 })
    expect(Buffer.from(chunk.data, "base64").toString()).toBe("export const a = 1\n")
    expect(chunk.size).toBe(19)
  }),
)
