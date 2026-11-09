import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { createServer } from "node:http"
import { PreviewOrigin } from "@opencode/core/preview/origin"

// The control plane learns the preview's public address only after Northflank created the VM, so a VM may ask before
// it is known.
const cp = { answers: [] as unknown[], requests: [] as { url?: string; auth?: string }[] }
const server = createServer((req, res) => {
  cp.requests.push({ url: req.url, auth: req.headers.authorization })
  res.writeHead(200, { "content-type": "application/json" })
  res.end(JSON.stringify(cp.answers.length > 1 ? cp.answers.shift() : cp.answers[0]))
})

beforeAll(() => new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)))
afterAll(() => server.close())

const target = () => ({
  url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
  projectID: "prj_vm",
  token: "vm-token",
})

describe("PreviewOrigin", () => {
  test("on a VM the preview status carries the public origin from the control plane", async () => {
    cp.answers = [{}, {}, { preview: "https://p--preview.code.run" }]
    cp.requests = []
    const origin = PreviewOrigin.poll(target(), { interval: 20 })
    expect(origin.get()).toBeUndefined()
    const deadline = Date.now() + 5_000
    while (!origin.get() && Date.now() < deadline) await Bun.sleep(10)
    expect(origin.get()).toBe("https://p--preview.code.run")
    const asked = cp.requests.length
    await Bun.sleep(100)
    // Asked once it is known: no more requests.
    expect(cp.requests.length).toBe(asked)
    expect(cp.requests[0]).toEqual({ url: "/internal/projects/prj_vm/vm", auth: "Bearer vm-token" })
    origin.close()
  })

  // The panel only hears status changes, so the status is sent again once the origin arrives.
  test("tells once when the origin becomes known", async () => {
    cp.answers = [{}, { preview: "https://p--preview.code.run" }]
    cp.requests = []
    const known: string[] = []
    const origin = PreviewOrigin.poll(target(), { interval: 20, onKnown: (value) => known.push(value) })
    const deadline = Date.now() + 5_000
    while (known.length === 0 && Date.now() < deadline) await Bun.sleep(10)
    await Bun.sleep(60)
    expect(known).toEqual(["https://p--preview.code.run"])
    origin.close()
  })

  test("close stops asking", async () => {
    cp.answers = [{}]
    cp.requests = []
    const origin = PreviewOrigin.poll(target(), { interval: 20 })
    await Bun.sleep(60)
    origin.close()
    const asked = cp.requests.length
    await Bun.sleep(100)
    expect(cp.requests.length).toBe(asked)
  })
})
