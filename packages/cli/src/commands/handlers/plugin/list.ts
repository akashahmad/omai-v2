import { EOL } from "node:os"
import { Effect } from "effect"
import { OpenCode, type PluginInfo } from "@opencode/client"
import { Service } from "@opencode/client/effect/service"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"
import { ServerConnection } from "../../../services/server-connection"

export default Runtime.handler(
  Commands.commands.plugin.commands.list,
  Effect.fn("cli.plugin.list")(function* (input) {
    const { endpoint } = yield* ServerConnection.resolve()
    const client = OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) })
    const response = yield* Effect.promise(() => client.plugin.list({ location: { directory: process.cwd() } }))
    const output = format(response.data, input.builtin)
    if (!output) {
      process.stdout.write("No plugins found" + EOL)
      return
    }
    process.stdout.write(output + EOL)
  }),
)

export function format(plugins: readonly PluginInfo[], builtin = false) {
  const server = plugins
    .filter((plugin) => builtin || plugin.source.type !== "builtin")
    .map((plugin) => ({
      id: plugin.id ?? "-",
      version:
        plugin.source.type === "package"
          ? (plugin.source.version ?? "-")
          : plugin.source.type === "local"
            ? "local"
            : "-",
      target:
        plugin.source.type === "package"
          ? plugin.source.target
          : plugin.source.type === "local"
            ? plugin.source.path
            : plugin.source.type,
    }))
  const rows = server
    .toSorted((a, b) => a.id.localeCompare(b.id) || a.target.localeCompare(b.target))
    .map((item) => [
      item.id,
      /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(item.version) ? item.version.slice(0, 7) : item.version,
      item.target,
    ])
  if (!rows.length) return ""
  const table = [["ID", "VERSION", "SOURCE"], ...rows]
  const widths = [0, 1].map((index) => Math.max(...table.map((row) => row[index].length)))
  return table.map((row) => `${row[0].padEnd(widths[0])}  ${row[1].padEnd(widths[1])}  ${row[2]}`).join(EOL)
}
