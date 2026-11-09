import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { createServer, type IncomingMessage } from "node:http"
import { writeFile } from "node:fs/promises"
import path from "node:path"
import { PublishRemote } from "../../src/publish/remote"
import { tmpdir } from "../fixture/tmpdir"

const seen: { method: string; url: string; auth?: string; body: string }[] = []
const answers = new Map<string, { status: number; body?: unknown }>()
const server = createServer(async (req: IncomingMessage, res) => {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  seen.push({ method: req.method ?? "", url: req.url ?? "", auth: req.headers.authorization, body: Buffer.concat(chunks).toString() })
  if (req.url?.startsWith("/internal/projects/slow/")) return
  const answer = answers.get(`${req.method} ${(req.url ?? "").split("?")[0]}`) ?? { status: 404 }
  res.writeHead(answer.status, { "content-type": "application/json" })
  res.end(answer.body === undefined ? "" : JSON.stringify(answer.body))
})
let base = ""
let root: Awaited<ReturnType<typeof tmpdir>>

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  root = await tmpdir("omai-publish-remote-")
})
afterAll(async () => {
  server.closeAllConnections()
  server.close()
  await root[Symbol.asyncDispose]()
})

const client = () => PublishRemote.client({ url: base, projectID: "p 1", token: "tok" })
const failure = (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (error: unknown) => error,
  )

describe("publish remote client", () => {
  test("calls the project's routes with its token", async () => {
    answers.set("GET /internal/projects/p%201/publish", { status: 200, body: { configured: true, zone: "omai.test" } })
    expect(await client().status()).toEqual({ configured: true, zone: "omai.test" })
    expect(seen.at(-1)?.auth).toBe("Bearer tok")
  })

  test("client maps an error answer to RemoteError", async () => {
    answers.set("POST /internal/projects/p%201/publish/claim", {
      status: 409,
      body: { kind: "taken", message: "This name is taken. Choose another." },
    })
    const error = await failure(client().claim("x"))
    expect(error).toBeInstanceOf(PublishRemote.RemoteError)
    expect(error).toMatchObject({ kind: "taken", message: "This name is taken. Choose another." })
  })

  test("deploy streams the zip and reports the log of a failure", async () => {
    const zip = path.join(root.path, "b.zip")
    await writeFile(zip, "zipdata")
    answers.set("POST /internal/projects/p%201/publish/deploy", {
      status: 502,
      body: { kind: "cloudflare", message: "The upload to Cloudflare failed.", log: "wrangler said no" },
    })
    const error = await failure(client().deploy(zip, { kind: "nuxt", entry: "index.js" }, new AbortController().signal))
    expect(error).toMatchObject({ kind: "cloudflare", log: "wrangler said no" })
    expect(seen.at(-1)).toMatchObject({ url: "/internal/projects/p%201/publish/deploy?kind=nuxt&entry=index.js", body: "zipdata" })
  })

  test("client reports an unreachable control plane plainly", async () => {
    const down = PublishRemote.client({ url: "http://127.0.0.1:1", projectID: "p", token: "t" })
    expect(await failure(down.status())).toMatchObject({
      kind: "other",
      message: "Couldn't reach O M A I +. Try again in a moment.",
    })
    answers.set("GET /internal/projects/p%201/domains", { status: 500 })
    expect(await failure(client().domains.list())).toMatchObject({ kind: "other" })
  })

  test("a request that runs out of time says so", async () => {
    const slow = PublishRemote.client({ url: base, projectID: "slow", token: "t" }, { timeoutMs: 200 })
    expect(await failure(slow.status())).toMatchObject({
      kind: "other",
      message: "O M A I + took too long to answer. Try again in a moment.",
    })
  })

  test("a deploy may take longer than the control plane's queue and upload together", () => {
    expect(PublishRemote.DEPLOY_TIMEOUT).toBeGreaterThan(120_000 + 300_000 + 600_000)
  })

  test("target needs the control plane URL, project and token", () => {
    expect(PublishRemote.target({})).toBeUndefined()
    expect(
      PublishRemote.target({ OMAI_CONTROL_PLANE_URL: "http://cp/", OMAI_PROJECT_ID: "p", OMAI_PROJECT_TOKEN: "t" }),
    ).toEqual({ url: "http://cp", projectID: "p", token: "t" })
  })
})
