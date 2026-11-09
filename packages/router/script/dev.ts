#!/usr/bin/env bun
// Runs the router under Node, as production does. Bun's node:http does not carry raw WebSocket bytes through an
// upgraded socket, so under Bun terminals connect but nothing typed reaches them.
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

const outdir = await mkdtemp(path.join(tmpdir(), "omai-router-"))
const built = await Bun.build({
  entrypoints: [new URL("../src/main.ts", import.meta.url).pathname],
  target: "node",
  outdir,
})
if (!built.success) {
  console.error(built.logs.join("\n"))
  process.exit(1)
}
const child = Bun.spawn(["node", path.join(outdir, "main.js")], { stdout: "inherit", stderr: "inherit" })
const stop = () => child.kill("SIGTERM")
process.on("SIGINT", stop)
process.on("SIGTERM", stop)
const code = await child.exited
await rm(outdir, { recursive: true, force: true })
process.exit(code)
