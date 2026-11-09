#!/usr/bin/env bun
// Starts the control plane and the router together (multi-user mode, local VMs) and stops both on exit.
// Usage: bun run dev:multi (loads .env.local) or bun run dev:multi:prod (loads .env.prod).
const root = new URL("..", import.meta.url).pathname
const children = [
  Bun.spawn(["bun", "src/main.ts"], { cwd: `${root}packages/controlplane`, stdout: "inherit", stderr: "inherit" }),
  // The router runs under Node (see its script/dev.ts): Bun does not pass WebSocket bytes through it.
  Bun.spawn(["bun", "script/dev.ts"], { cwd: `${root}packages/router`, stdout: "inherit", stderr: "inherit" }),
]
const stop = () => {
  for (const child of children) child.kill("SIGTERM")
}
process.on("SIGINT", stop)
process.on("SIGTERM", stop)
const code = await Promise.race(children.map((child) => child.exited))
stop()
await Promise.all(children.map((child) => child.exited))
process.exit(code)
