import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { NorthflankClient, NorthflankError } from "../src/vm/northflank-client.js"
import { fakeNorthflank } from "./fixture/fake-northflank.js"

let fake: Awaited<ReturnType<typeof fakeNorthflank>>
beforeAll(async () => {
  fake = await fakeNorthflank()
})
afterAll(() => fake.close())
beforeEach(() => fake.reset())

const client = () => NorthflankClient.make({ apiBase: fake.apiBase, token: "nf-secret-token", project: "omaiv2" })
const service = (name: string) => ({
  name,
  billing: { deploymentPlan: "nf-compute-20" },
  deployment: { instances: 0, external: { imagePath: "docker.io/x/omai-vm:latest" }, docker: { configType: "default" } },
  ports: [],
})

describe("NorthflankClient", () => {
  test("lists follow the cursor across pages", async () => {
    const nf = client()
    for (const index of [1, 2, 3, 4, 5]) await nf.createService(service(`svc-${index}`))
    fake.state.pageSize = 2
    expect((await nf.listServices()).map((item) => item.name)).toEqual(["svc-1", "svc-2", "svc-3", "svc-4", "svc-5"])
    expect(fake.state.requests.filter((request) => request.method === "GET" && request.path === "/v1/projects/omaiv2/services").length).toBe(3)
    expect(fake.state.requests.every((request) => request.auth === "Bearer nf-secret-token")).toBe(true)
  })

  test("a 429 is retried after Retry-After", async () => {
    const nf = client()
    fake.state.limited = { count: 2, retryAfter: "0" }
    expect(await nf.listServices()).toEqual([])
    expect(fake.state.requests.length).toBe(3)
    fake.state.limited = { count: 10, retryAfter: "0" }
    const error = await nf.listServices().catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(NorthflankError)
    expect((error as NorthflankError).status).toBe(429)
  })

  test("errors carry Northflank's message, never the token", async () => {
    const nf = client()
    const error = await nf.getService("missing").catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(NorthflankError)
    expect((error as NorthflankError).status).toBe(404)
    expect((error as NorthflankError).message).toBe("Could not find service")
    expect(String((error as Error).stack)).not.toContain("nf-secret-token")
  })

  test("the client has no way to delete anything", () => {
    expect(Object.keys(client()).filter((name) => /delete|remove|destroy/i.test(name))).toEqual([])
  })
})
