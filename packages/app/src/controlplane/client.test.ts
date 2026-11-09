import { describe, expect, test } from "bun:test"
import { ControlPlaneClient } from "./client"

/** A token whose payload carries `exp`, the only part the client reads. */
function accessToken(n: number, expSeconds = Math.floor(Date.now() / 1000) + 300) {
  return `${Buffer.from(JSON.stringify({ typ: "access", sub: "u", sid: "s", exp: expSeconds, n })).toString("base64url")}.sig`
}

function fakeControlPlane(options: { refreshOk?: boolean; projects?: unknown[] } = {}) {
  const state = {
    issued: 0,
    refreshes: 0,
    valid: new Set<string>(),
    seen: [] as { path: string; auth: string | null }[],
    credentials: [] as (RequestCredentials | undefined)[],
  }

  const user = { id: "u", username: "ada", email: "ada@x.y", admin: true }

  const issue = () => {
    const token = accessToken(++state.issued)
    state.valid.add(token)

    return Response.json({ accessToken: token, user })
  }

  // Injected as the client's fetch, like the app's other network tests: happy-dom replaces the globals that
  // Bun.serve needs. Each call is recorded with the credentials mode the client asked for.
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(String(input), init)
    state.credentials.push(init?.credentials)

    return route(req)
  }) as typeof fetch

  async function route(req: Request) {
    const path = new URL(req.url).pathname
    state.seen.push({ path, auth: req.headers.get("authorization") })

    if (path === "/auth/login") {
      const body = (await req.json()) as { password: string }

      return body.password === "right" ? issue() : Response.json({ error: "invalid" }, { status: 401 })
    }

    if (path === "/auth/refresh") {
      state.refreshes++

      return options.refreshOk === false ? Response.json({ error: "unauthenticated" }, { status: 401 }) : issue()
    }

    const token = req.headers.get("authorization")?.replace("Bearer ", "") ?? ""

    if (!state.valid.has(token)) return Response.json({ error: "unauthenticated" }, { status: 401 })

    if (path === "/projects") return Response.json(options.projects ?? [])

    return new Response(null, { status: 204 })
  }

  return { url: "http://cp.test", fetchImpl, state }
}

describe("ControlPlaneClient", () => {
  test("login stores the token in memory and sends Bearer", async () => {
    const cp = fakeControlPlane()
    const client = ControlPlaneClient.make(cp.url, cp.fetchImpl)
    expect(await client.login({ login: "ada", password: "wrong" })).toBe("invalid")
    const user = await client.login({ login: "ada", password: "right" })
    expect(user).toEqual({ id: "u", username: "ada", email: "ada@x.y", admin: true })
    expect(await client.projects.list()).toEqual([])
    expect(cp.state.seen.at(-1)?.auth).toBe(`Bearer ${client.token()}`)
    expect(cp.state.credentials.every((mode) => mode === "include")).toBe(true)
  })

  test("401 triggers one refresh then retries", async () => {
    const cp = fakeControlPlane()
    const client = ControlPlaneClient.make(cp.url, cp.fetchImpl)
    await client.login({ login: "ada", password: "right" })
    cp.state.valid.clear()
    expect(await client.projects.list()).toEqual([])
    expect(cp.state.refreshes).toBe(1)
  })

  test("a token close to expiry is refreshed before the request", async () => {
    const cp = fakeControlPlane()
    const client = ControlPlaneClient.make(cp.url, cp.fetchImpl)
    await client.login({ login: "ada", password: "right" })
    client.setToken(accessToken(99, Math.floor(Date.now() / 1000) + 10))
    await client.projects.list()
    expect(cp.state.refreshes).toBe(1)
  })

  test("refresh 401 emits onSignedOut", async () => {
    const cp = fakeControlPlane({ refreshOk: false })
    const client = ControlPlaneClient.make(cp.url, cp.fetchImpl)
    const signedOut: number[] = []
    client.onSignedOut(() => signedOut.push(1))
    expect(await client.refresh()).toBeUndefined()
    expect(signedOut).toHaveLength(1)
    await expect(client.projects.list()).rejects.toBeInstanceOf(ControlPlaneClient.Unauthenticated)
  })

  test("concurrent 401s share one refresh", async () => {
    const cp = fakeControlPlane()
    const client = ControlPlaneClient.make(cp.url, cp.fetchImpl)
    await client.login({ login: "ada", password: "right" })
    cp.state.valid.clear()
    await Promise.all([client.projects.list(), client.projects.list(), client.projects.list()])
    expect(cp.state.refreshes).toBe(1)
  })

  test("decodes paused projects", async () => {
    const project = { id: "p", name: "P", slug: "p", vmState: "paused", createdAt: 1, updatedAt: 2 }
    const cp = fakeControlPlane({ projects: [project] })
    const client = ControlPlaneClient.make(cp.url, cp.fetchImpl)
    await client.login({ login: "ada", password: "right" })
    expect((await client.projects.list())[0]?.vmState).toBe("paused")
  })

  test("presence and wake post to the project", async () => {
    const cp = fakeControlPlane()
    const client = ControlPlaneClient.make(cp.url, cp.fetchImpl)
    await client.login({ login: "ada", password: "right" })
    await client.projects.presence("p 1")
    await client.projects.wake("p1")
    expect(cp.state.seen.slice(-2).map((item) => item.path)).toEqual(["/projects/p%201/presence", "/projects/p1/wake"])
  })

  test("decodes the admin flag", async () => {
    const cp = fakeControlPlane()
    const client = ControlPlaneClient.make(cp.url, cp.fetchImpl)
    const signedIn = await client.login({ login: "ada", password: "right" })
    expect(signedIn !== "invalid" && signedIn.admin).toBe(true)
  })

  test("platform open and models", async () => {
    const cp = fakeControlPlane()
    const client = ControlPlaneClient.make(cp.url, cp.fetchImpl)
    await client.login({ login: "ada", password: "right" })
    await client.platform.setModels([{ providerID: "openai", modelID: "gpt-5" }])
    expect(cp.state.seen.at(-1)?.path).toBe("/platform/models")
  })
})
