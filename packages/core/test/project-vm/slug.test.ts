import { afterEach, expect, test } from "bun:test"
import { createServer } from "node:http"
import { ProjectVm } from "../../src/project-vm/project-vm"

const servers: { close: () => void }[] = []
afterEach(() => servers.splice(0).forEach((server) => server.close()))

/** A control plane whose `/vm` answers `answers` in turn, recording the authorization it saw. */
async function controlPlane(answers: unknown[]) {
  const seen: string[] = []
  const server = createServer((req, res) => {
    seen.push(`${req.url} ${req.headers.authorization}`)
    res.setHeader("content-type", "application/json")
    res.end(JSON.stringify(answers.shift() ?? {}))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  servers.push(server)
  const port = (server.address() as { port: number }).port
  return { url: `http://127.0.0.1:${port}`, seen }
}

test("a VM made for its project uses the slug it was given", async () => {
  expect(await ProjectVm.slug({ OMAI_PROJECT_SLUG: "shop" })).toBe("shop")
})

test("a reserve VM asks the control plane, until claimed, then keeps the answer", async () => {
  // An answer that isn't a plain folder name never becomes a path.
  const cp = await controlPlane([{}, { slug: "../etc" }, { slug: "my-shop" }])
  const env = { OMAI_CONTROL_PLANE_URL: cp.url, OMAI_PROJECT_ID: "p1", OMAI_PROJECT_TOKEN: "t" }
  expect(await ProjectVm.slug(env)).toBeUndefined()
  expect(await ProjectVm.slug(env)).toBeUndefined()
  expect(await ProjectVm.slug(env)).toBe("my-shop")
  expect(await ProjectVm.slug(env)).toBe("my-shop")
  expect(cp.seen).toEqual(Array.from({ length: 3 }, () => "/internal/projects/p1/vm Bearer t"))
})
