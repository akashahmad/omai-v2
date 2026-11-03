import path from "node:path"
import { OMAI_CHANNEL } from "./version"

export function databasePath(data: string) {
  const filename =
    process.env.OMAI_DB ??
    (["latest", "dev", "beta", "next", "prod"].includes(OMAI_CHANNEL) ||
    process.env.OMAI_DISABLE_CHANNEL_DB === "1" ||
    process.env.OMAI_DISABLE_CHANNEL_DB === "true"
      ? "omai.db"
      : `omai-${OMAI_CHANNEL.replace(/[^a-zA-Z0-9._-]/g, "-")}.db`)
  return filename === ":memory:" ? filename : path.resolve(data, filename)
}
