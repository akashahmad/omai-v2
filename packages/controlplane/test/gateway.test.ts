import { afterEach, describe, expect, test } from "bun:test"
import { createServer, type IncomingMessage, type Server } from "node:http"
import { Gateway } from "../src/gateway.js"

const cleanup: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
})

function listen(server: Server) {
  return new Promise<string>((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      cleanup.push(() => new Promise<void>((done) => server.close(() => done())))
      cleanup.push(() => server.closeAllConnections())
      resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}`)
    }),
  )
}

const b64 = (text: string) => Buffer.from(text).toString("base64url")

async function setup() {
  const seen: { url: string; headers: IncomingMessage["headers"]; body: string }[] = []
  const upstream = await listen(
    createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on("data", (chunk: Buffer) => chunks.push(chunk))
      req.on("end", () => {
        seen.push({ url: req.url ?? "", headers: req.headers, body: Buffer.concat(chunks).toString() })
        res.writeHead(200, { "content-type": "text/event-stream" })
        res.write("data: one\n\n")
        // The second event comes later: it must arrive on its own, not held back with the first.
        setTimeout(() => res.end("data: two\n\n"), 150)
      })
    }),
  )
  const host = new URL(upstream).host
  const handle = Gateway.make({
    owner: async (projectID, token) => (projectID === "p1" && token === "pt-1" ? "user-a" : undefined),
    secret: async (userID, ref) => {
      if (ref === "u~c1" && userID === "user-a") return { secret: "real-access", hosts: [host] }
      if (ref === "s~openai") return { secret: "shared-key", hosts: ["api.openai.com"] }
      return undefined
    },
  })
  const gateway = await listen(
    createServer((req, res) => {
      const match = Gateway.match(new URL(req.url ?? "/", "http://internal").pathname)
      if (!match) return res.writeHead(404).end()
      void handle(req, res, match)
    }),
  )
  return { upstream, gateway, seen }
}

describe("Gateway", () => {
  test("swaps the stand-in for the real secret wherever it is, and streams the answer as it comes", async () => {
    const s = await setup()
    const res = await fetch(
      `${s.gateway}/internal/projects/p1/gateway/u~c1/${b64(s.upstream)}/v1/responses?key=omai-gw.u~c1&x=1`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer omai-gw.u~c1",
          "x-api-key": "omai-gw.u~c1",
          "x-omai-project-token": "pt-1",
          "content-type": "application/json",
        },
        body: JSON.stringify({ model: "gpt-5" }),
      },
    )
    expect(res.status).toBe(200)
    const reader = res.body!.getReader()
    const first = new TextDecoder().decode((await reader.read()).value)
    expect(first).toBe("data: one\n\n")
    let rest = ""
    for (let next = await reader.read(); !next.done; next = await reader.read()) rest += new TextDecoder().decode(next.value)
    expect(rest).toBe("data: two\n\n")
    const call = s.seen[0]!
    expect(call.url).toBe("/v1/responses?key=real-access&x=1")
    expect(call.headers.authorization).toBe("Bearer real-access")
    expect(call.headers["x-api-key"]).toBe("real-access")
    expect(call.headers["x-omai-project-token"]).toBeUndefined()
    expect(call.headers.host).toBe(new URL(s.upstream).host)
    expect(call.body).toBe(JSON.stringify({ model: "gpt-5" }))
  })

  test("never sends a secret to a host outside the provider's own", async () => {
    const s = await setup()
    const res = await fetch(`${s.gateway}/internal/projects/p1/gateway/s~openai/${b64(s.upstream)}/v1/models`, {
      headers: { authorization: "Bearer omai-gw.s~openai", "x-omai-project-token": "pt-1" },
    })
    expect(res.status).toBe(403)
    expect(s.seen).toHaveLength(0)
  })

  test("a wrong project token, or a credential that isn't the owner's, gets nothing", async () => {
    const s = await setup()
    const wrong = await fetch(`${s.gateway}/internal/projects/p1/gateway/u~c1/${b64(s.upstream)}/v1/models`, {
      headers: { "x-omai-project-token": "pt-2" },
    })
    expect(wrong.status).toBe(401)
    const other = await fetch(`${s.gateway}/internal/projects/p1/gateway/u~other/${b64(s.upstream)}/v1/models`, {
      headers: { "x-omai-project-token": "pt-1" },
    })
    expect(other.status).toBe(404)
    expect(s.seen).toHaveLength(0)
  })
})
