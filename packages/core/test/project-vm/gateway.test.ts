import { describe, expect, test } from "bun:test"
import { ProjectVmGateway } from "@opencode/core/project-vm/gateway"

const target = { url: "http://controlplane:4101", projectID: "p1", token: "pt-1" }

function recorder() {
  const calls: Request[] = []
  const fetch = (async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
    calls.push(input instanceof Request ? input : new Request(String(input), init))
    return new Response("ok")
  }) as typeof globalThis.fetch
  return { calls, fetch }
}

describe("ProjectVmGateway", () => {
  test("a request holding a stand-in goes to the gateway with the project token, everything else unchanged", async () => {
    const r = recorder()
    const wrapped = ProjectVmGateway.wrap(r.fetch, target)
    await wrapped("https://api.openai.com/v1/responses?x=1", {
      method: "POST",
      headers: { authorization: "Bearer omai-gw.s~openai", "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-5" }),
    })
    const call = r.calls[0]!
    const origin = Buffer.from("https://api.openai.com").toString("base64url")
    expect(call.url).toBe(`http://controlplane:4101/internal/projects/p1/gateway/s~openai/${origin}/v1/responses?x=1`)
    expect(call.method).toBe("POST")
    expect(call.headers.get("authorization")).toBe("Bearer omai-gw.s~openai")
    expect(call.headers.get("x-omai-project-token")).toBe("pt-1")
    expect(await call.text()).toBe(JSON.stringify({ model: "gpt-5" }))
  })

  test("a stand-in in the address counts too, and a Request object works like a URL", async () => {
    const r = recorder()
    const wrapped = ProjectVmGateway.wrap(r.fetch, target)
    await wrapped(new Request("https://generativelanguage.googleapis.com/v1beta/models?key=omai-gw.u~cred_1"))
    expect(r.calls[0]!.url).toContain("/gateway/u~cred_1/")
    expect(r.calls[0]!.url).toEndWith("/v1beta/models?key=omai-gw.u~cred_1")
  })

  test("requests without a stand-in are passed through as they were", async () => {
    const r = recorder()
    const wrapped = ProjectVmGateway.wrap(r.fetch, target)
    await wrapped("https://registry.npmjs.org/react", { headers: { authorization: "Bearer real" } })
    expect(r.calls[0]!.url).toBe("https://registry.npmjs.org/react")
    expect(r.calls[0]!.headers.get("x-omai-project-token")).toBeNull()
  })
})
