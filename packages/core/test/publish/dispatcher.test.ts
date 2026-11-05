import { describe, expect, test } from "bun:test"
import { dispatch } from "../../src/publish/dispatcher/index"

function setup(kv: Record<string, string>, fail?: Error) {
  const calls: string[] = []
  const env = {
    ZONE: "omai.ch",
    HOSTNAMES: { get: async (key: string) => kv[key] ?? null },
    DISPATCHER: {
      get: (name: string) => ({
        fetch: async () => {
          calls.push(name)
          if (fail) throw fail
          return new Response(`served ${name}`)
        },
      }),
    },
  }
  return { env, calls }
}

describe("dispatch", () => {
  test("dispatcher serves legacy string values", async () => {
    const { env, calls } = setup({ "old.edu": "my-app" })
    const res = await dispatch(new Request("https://old.edu/"), env)
    expect(calls).toEqual(["my-app"])
    expect(await res.text()).toBe("served my-app")
  })

  test("serves JSON script values", async () => {
    const { env, calls } = setup({ "a.edu": '{"script":"json-app"}' })
    await dispatch(new Request("https://a.edu/"), env)
    expect(calls).toEqual(["json-app"])
  })

  test("dispatcher 301 keeps path and query", async () => {
    const { env, calls } = setup({ "alias.edu": '{"redirect":"www.primary.edu"}' })
    const http = await dispatch(new Request("http://alias.edu/a/b?x=1"), env)
    expect(http.status).toBe(301)
    expect(http.headers.get("location")).toBe("https://alias.edu/a/b?x=1")
    const res = await dispatch(new Request("https://alias.edu/a/b?x=1"), env)
    expect(res.status).toBe(301)
    expect(res.headers.get("location")).toBe("https://www.primary.edu/a/b?x=1")
    expect(calls).toEqual([])
  })

  test("falls back to the platform subdomain, then 404", async () => {
    const { env, calls } = setup({})
    await dispatch(new Request("https://site.omai.ch/"), env)
    expect(calls).toEqual(["site"])
    expect((await dispatch(new Request("https://www.omai.ch/"), env)).status).toBe(404)
    expect((await dispatch(new Request("https://unknown.edu/"), env)).status).toBe(404)
  })

  test("worker not found gives 404; other errors propagate", async () => {
    const missing = setup({}, new Error("Worker not found."))
    expect((await dispatch(new Request("https://site.omai.ch/"), missing.env)).status).toBe(404)
    const broken = setup({}, new Error("boom"))
    await expect(dispatch(new Request("https://site.omai.ch/"), broken.env)).rejects.toThrow("boom")
  })
})
