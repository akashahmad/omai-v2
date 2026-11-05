// A stand-in dev server for preview tests. MODE picks how it misbehaves.
import { spawn } from "node:child_process"
import http from "node:http"

const page = "<html><head><title>fake</title></head><body>fake dev server</body></html>"

const serve = (port, onListen) => {
  const server = http.createServer((_, res) => {
    res.setHeader("content-type", "text/html")
    res.end(page)
  })
  server.listen(port, "127.0.0.1", () => onListen(server.address().port))
}

const mode = process.env.MODE ?? "env-port"

if (mode === "env-port") serve(Number(process.env.PORT), (port) => console.log(`listening on ${port}`))

// Picks its own port and logs a misleading one, like a server that ignores PORT.
if (mode === "own-port") serve(0, () => console.log("ready on http://localhost:9"))

if (mode === "ansi")
  serve(Number(process.env.PORT), (port) => console.log(`\x1b[32m  Local: http://localhost:\x1b[1m${port}\x1b[0m/`))

if (mode === "exit") {
  console.log("boom")
  process.exit(1)
}

if (mode === "never") setInterval(() => {}, 1000)

// The listening server is a grandchild, like `npm run dev` starting vite.
if (mode === "child") {
  const child = spawn(process.execPath, [new URL(import.meta.url).pathname], {
    env: { ...process.env, MODE: "own-port" },
    stdio: "inherit",
  })
  console.log(`child:${child.pid}`)
  setInterval(() => {}, 1000)
}

// Serves on PORT, then dies after CRASH_AFTER ms, as a dev server that crashes once it is up.
if (mode === "crash")
  serve(Number(process.env.PORT), () => setTimeout(() => process.exit(1), Number(process.env.CRASH_AFTER ?? "300")))
