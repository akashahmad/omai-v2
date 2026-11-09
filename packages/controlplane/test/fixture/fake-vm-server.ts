// Stands in for `omai serve` in tests: answers /api/info, the busy report (from `busy.json` in its working folder,
// idle by default; `"error"` answers 500) and reports which env names it was given.
import { readFileSync } from "node:fs"
import { createServer } from "node:http"

const port = Number(process.argv[process.argv.indexOf("--port") + 1])
createServer((req, res) => {
  if (req.url === "/api/info") return res.end(JSON.stringify({ ok: true }))
  if (req.url === "/api/experimental/project-vm/busy") {
    const text = (() => {
      try {
        return readFileSync("busy.json", "utf8")
      } catch {
        return JSON.stringify({ busy: false, reasons: [] })
      }
    })()
    if (text.trim() === '"error"') {
      res.statusCode = 500
      return res.end()
    }
    return res.end(text)
  }
  if (req.url === "/token") return res.end(process.env.OMAI_PROJECT_TOKEN)
  if (req.url === "/env") return res.end(JSON.stringify(Object.keys(process.env)))
  res.statusCode = 404
  res.end()
}).listen(port, process.argv.includes("--hostname") ? process.argv[process.argv.indexOf("--hostname") + 1] : "127.0.0.1")
