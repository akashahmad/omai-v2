import { afterAll, beforeAll, expect } from "bun:test"
import path from "node:path"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Location } from "@opencode/core/location"
import { Project } from "@opencode/core/project"
import { GitToolPlugin } from "@opencode/core/plugin/git-tool"
import { Rpc } from "@opencode/core/rpc"
import { AbsolutePath } from "@opencode/core/schema"
import { GitTool } from "@opencode/schema/git-tool"
import { Effect, Layer, Stream } from "effect"
import { runGit } from "../../src/git-tool/run"
import { location } from "../fixture/location"
import { tmpdir } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"
import { host } from "./host"

const saved = { ...process.env }
let home: Awaited<ReturnType<typeof tmpdir>>
let repo: Awaited<ReturnType<typeof tmpdir>>

beforeAll(async () => {
  home = await tmpdir("omai-git-plugin-home-")
  repo = await tmpdir("omai-git-plugin-repo-")
  process.env.HOME = home.path
  process.env.GIT_CONFIG_GLOBAL = path.join(home.path, "gitconfig")
  process.env.GIT_CONFIG_NOSYSTEM = "1"
  await runGit({ cwd: repo.path, args: ["init", "-b", "main"] })
  await runGit({ cwd: repo.path, args: ["config", "user.name", "Test User"] })
  await runGit({ cwd: repo.path, args: ["config", "user.email", "test@example.com"] })
})

afterAll(async () => {
  process.env.HOME = saved.HOME
  delete process.env.GIT_CONFIG_GLOBAL
  delete process.env.GIT_CONFIG_NOSYSTEM
  await home[Symbol.asyncDispose]()
  await repo[Symbol.asyncDispose]()
})

const it = testEffect(
  AppNodeBuilder.build(Rpc.node, [
    Location.node.replace(
      Layer.effect(
        Location.Service,
        Effect.sync(() => Location.Service.of(location(Location.Ref.make({ directory: AbsolutePath.make(repo.path) })))),
      ),
    ),
  ]),
)

it.live("serves status, stage and commit, and publishes changed after each mutation", () =>
  Effect.gen(function* () {
    const rpc = yield* Rpc.Service
    yield* GitToolPlugin.Plugin.effect(
      host({
        location: new Location.Info({
          directory: AbsolutePath.make(repo.path),
          project: {
            id: Project.ID.global,
            directory: AbsolutePath.make(repo.path),
            canonical: AbsolutePath.make(repo.path),
          },
        }),
        rpc: Object.assign(rpc.client, { register: rpc.register }),
      }),
    )
    const client = rpc.client(GitTool.Definition)
    const changed: GitTool.Status[] = []
    yield* client.events.subscribe("changed").pipe(
      Stream.runForEach((status) => Effect.sync(() => void changed.push(status.data))),
      Effect.forkScoped({ startImmediately: true }),
    )
    yield* Effect.yieldNow
    yield* Effect.promise(() => Bun.write(path.join(repo.path, "a.txt"), "one\n"))

    expect((yield* client.status({})).files.map((file) => file.path)).toEqual(["a.txt"])
    yield* client.stage({ paths: ["a.txt"], staged: true })
    yield* client.commit({ message: "first" })
    yield* Effect.sleep("50 millis")

    expect((yield* client.status({})).files).toEqual([])
    expect(changed.length).toBeGreaterThanOrEqual(2)
    expect(changed.at(-1)?.files).toEqual([])

    const failure = yield* client.commit({ message: "again" }).pipe(Effect.flip)
    expect(failure).toMatchObject({ type: "git.failed", data: { kind: "nothing-to-commit" } })
  }),
)
