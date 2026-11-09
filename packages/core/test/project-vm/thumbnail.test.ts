import { describe, expect, test } from "bun:test"
import { createServer } from "node:http"
import { ProjectVmThumbnail } from "../../src/project-vm/thumbnail"

async function receiver(status = 204) {
  const received: { url: string; authorization: string; type: string; body: Buffer }[] = []
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on("data", (chunk: Buffer) => chunks.push(chunk))
    req.on("end", () => {
      received.push({
        url: req.url ?? "",
        authorization: req.headers.authorization ?? "",
        type: req.headers["content-type"] ?? "",
        body: Buffer.concat(chunks),
      })
      res.statusCode = status
      res.end()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  const port = typeof address === "object" && address ? address.port : 0
  return { url: `http://127.0.0.1:${port}`, received, close: () => server.close() }
}

describe("ProjectVmThumbnail", () => {
  test("target needs all three settings", () => {
    const env = { OMAI_CONTROL_PLANE_URL: "http://cp", OMAI_PROJECT_ID: "p1", OMAI_PROJECT_TOKEN: "t" }
    expect(ProjectVmThumbnail.target(env)).toEqual({ url: "http://cp", projectID: "p1", token: "t" })
    expect(ProjectVmThumbnail.target({ ...env, OMAI_PROJECT_TOKEN: "" })).toBeUndefined()
  })

  test("pushes the image to the control plane with the project token", async () => {
    const control = await receiver()
    const image = new Uint8Array([82, 73, 70, 70, 9, 9])
    expect(await ProjectVmThumbnail.push({ url: control.url, projectID: "p1", token: "secret" }, image)).toBe(true)
    control.close()
    expect(control.received).toHaveLength(1)
    expect(control.received[0]?.url).toBe("/internal/projects/p1/thumbnail")
    expect(control.received[0]?.authorization).toBe("Bearer secret")
    expect(control.received[0]?.type).toBe("image/webp")
    expect(new Uint8Array(control.received[0]!.body)).toEqual(image)
  })

  test("a refused or unreachable push reports false and never throws", async () => {
    const control = await receiver(401)
    expect(await ProjectVmThumbnail.push({ url: control.url, projectID: "p1", token: "x" }, new Uint8Array([1]))).toBe(
      false,
    )
    control.close()
    expect(
      await ProjectVmThumbnail.push({ url: "http://127.0.0.1:1", projectID: "p1", token: "x" }, new Uint8Array([1])),
    ).toBe(false)
  })
})
