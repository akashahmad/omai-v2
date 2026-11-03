import { EOL } from "node:os"
import { Effect } from "effect"
import { OpenCode } from "@opencode/client"
import { Service } from "@opencode/client/effect/service"
import { ServerConnection } from "../../../services/server-connection"

export interface Item {
  readonly runtime: "Server"
  readonly target: string
  readonly name: string
  readonly version?: string
  readonly outdated: boolean
  readonly error?: string
}

export const inspect = Effect.fn("cli.plugin.inspect")(function* (selected?: string) {
  const { endpoint } = yield* ServerConnection.resolve()
  const client = OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) })
  const location = { directory: process.cwd() }
  const listed = yield* Effect.promise(() => client.plugin.list({ location }))
  const serverTargets = new Set(
    listed.data.flatMap((plugin) => (plugin.source.type === "package" ? [plugin.source.target] : [])),
  )
  const server =
    selected === undefined || serverTargets.has(selected)
      ? yield* Effect.promise(() => client.plugin.check({ location, ...(selected ? { target: selected } : {}) }))
      : listed
  const serverItems = server.data.flatMap((plugin): Item[] => {
    if (plugin.source.type !== "package") return []
    if (selected !== undefined && plugin.source.target !== selected) return []
    return [
      {
        runtime: "Server",
        target: plugin.source.target,
        name: plugin.id ?? plugin.source.target,
        ...(plugin.source.version ? { version: displayVersion(plugin.source.version) } : {}),
        outdated: plugin.source.outdated === true,
        ...(plugin.state.status === "failed" ? { error: plugin.state.error } : {}),
      },
    ]
  })

  const items = serverItems
  if (selected !== undefined && !items.length) return yield* Effect.fail(new Error(`Plugin is not configured: ${selected}`))
  return { client, location, items }
})

export function displayVersion(version: string) {
  return /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(version) ? version.slice(0, 7) : version
}

export function format(items: readonly Item[]) {
  return ["Server"]
    .flatMap((runtime) => {
      const rows = items.filter((item) => item.runtime === runtime)
      if (!rows.length) return []
      return [
        runtime,
        ...rows.map(
          (item) =>
            `  ${item.name}${item.version ? ` ${item.version}` : ""} (${item.error ? "check failed" : item.outdated ? "update available" : "current"})`,
        ),
      ]
    })
    .join(EOL)
}
