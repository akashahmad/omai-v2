import { describe, expect, test } from "bun:test"
import type { ServerConnection } from "@/runtime/server/registry"
import { openProject, type OpenDeps } from "./open"

function harness(ready = true, prepared: Promise<void> = Promise.resolve()) {
  const calls: string[] = []
  const servers = new Map<string, ServerConnection.Http>()

  const deps: OpenDeps = {
    client: {
      projects: {
        open: async (id) => {
          calls.push(`open ${id}`)

          if (!ready) return "not-ready"

          return { routerUrl: `http://router.test/vm/${id}`, token: `token-${id}`, directory: `/home/omai/${id}-dir` }
        },
      },
    },
    addServer: (conn) => {
      calls.push(`add ${conn.http.url}`)
      servers.set(conn.http.url, conn)

      return conn
    },
    init: async (conn) => {
      calls.push(`init ${conn.http.url}`)
      await prepared
      calls.push(`prepared ${conn.http.url}`)
    },
    openDirectory: async (conn, directory, ready) => {
      calls.push(`look up ${directory}`)
      await ready
      calls.push(`navigate ${conn.http.url} ${directory}`)
    },
  }

  return { calls, servers, deps }
}

describe("openProject", () => {
  test("open registers a per-project connection with the token as password", async () => {
    const h = harness()
    await openProject({ id: "p1", name: "Shop" }, h.deps)
    expect(h.servers.get("http://router.test/vm/p1")).toEqual({
      type: "http",
      http: { url: "http://router.test/vm/p1", password: "token-p1" },
      displayName: "Shop",
    })
  })

  test("two projects get two connections", async () => {
    const h = harness()
    await openProject({ id: "p1", name: "Shop" }, h.deps)
    await openProject({ id: "p2", name: "Blog" }, h.deps)
    expect([...h.servers.keys()]).toEqual(["http://router.test/vm/p1", "http://router.test/vm/p2"])
  })

  test("the latest session is looked up while the folder is prepared, and opens once it is", async () => {
    const gate = Promise.withResolvers<void>()
    const h = harness(true, gate.promise)
    const opening = openProject({ id: "p1", name: "Shop" }, h.deps)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(h.calls).toEqual([
      "open p1",
      "add http://router.test/vm/p1",
      "init http://router.test/vm/p1",
      "look up /home/omai/p1-dir",
    ])
    gate.resolve()
    await opening
    expect(h.calls.slice(4)).toEqual([
      "prepared http://router.test/vm/p1",
      "navigate http://router.test/vm/p1 /home/omai/p1-dir",
    ])
  })

  test("a folder that can't be prepared fails the open", async () => {
    const h = harness(true, Promise.reject(new Error("no disk")))
    await expect(openProject({ id: "p1", name: "Shop" }, h.deps)).rejects.toThrow("no disk")
  })

  test("a project that is not ready adds nothing", async () => {
    const h = harness(false)
    expect(await openProject({ id: "p1", name: "Shop" }, h.deps)).toBe("not-ready")
    expect(h.servers.size).toBe(0)
  })
})
