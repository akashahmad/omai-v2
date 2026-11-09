import { describe, expect, test } from "bun:test"
import { createServer } from "node:http"
import { Effect, Fiber } from "effect"
import { ProjectVmBusy } from "@opencode/core/project-vm/busy"

const shell = { pid: 100, ppid: 1, command: "/bin/zsh" }
const idle = { sessions: 0, terminals: [], processes: [] }

describe("ProjectVmBusy.report", () => {
  test("idle when nothing runs", () => {
    expect(ProjectVmBusy.report(idle)).toEqual({ busy: false, reasons: [] })
  })

  test("a running session is busy", () => {
    expect(ProjectVmBusy.report({ ...idle, sessions: 2 })).toEqual({ busy: true, reasons: ["sessions:2"] })
  })

  test("an idle shell is not busy, a command is", () => {
    expect(ProjectVmBusy.report({ ...idle, terminals: [100], processes: [shell] }).busy).toBe(false)
    const running = [shell, { pid: 101, ppid: 100, command: "/bin/sleep" }]
    expect(ProjectVmBusy.report({ ...idle, terminals: [100], processes: running })).toEqual({
      busy: true,
      reasons: ["terminal:sleep"],
    })
    // A terminal that runs a program in place of its shell.
    const exec = [{ pid: 100, ppid: 1, command: "node" }]
    expect(ProjectVmBusy.report({ ...idle, terminals: [100], processes: exec }).reasons).toEqual(["terminal:node"])
    // A login shell's name starts with a dash; an exited terminal has no process.
    const login = [{ pid: 100, ppid: 1, command: "-zsh" }]
    expect(ProjectVmBusy.report({ ...idle, terminals: [100, 200], processes: login }).busy).toBe(false)
  })

  test("hold and release", () => {
    const first = ProjectVmBusy.hold("install")
    const second = ProjectVmBusy.hold("install")
    expect(ProjectVmBusy.report(idle).reasons).toEqual(["install"])
    first()
    first()
    expect(ProjectVmBusy.report(idle).reasons).toEqual(["install"])
    second()
    expect(ProjectVmBusy.report(idle).busy).toBe(false)
    const publish = ProjectVmBusy.hold("publish")
    expect(ProjectVmBusy.report(idle).reasons).toEqual(["publish"])
    publish()
  })

  test("a zip still uploading keeps the VM busy", () => {
    const upload = ProjectVmBusy.hold("upload")
    expect(ProjectVmBusy.report(idle).reasons).toEqual(["upload"])
    upload()
    expect(ProjectVmBusy.report(idle).busy).toBe(false)
  })

  test("preview counts for 2 minutes", () => {
    ProjectVmBusy.touch("preview", 1_000_000)
    expect(ProjectVmBusy.report({ ...idle, now: 1_000_000 + 119_000 }).reasons).toEqual(["preview"])
    expect(ProjectVmBusy.report({ ...idle, now: 1_000_000 + 120_000 }).busy).toBe(false)
  })
})

describe("ProjectVmBusy.processes", () => {
  test("lists this process under its parent", async () => {
    const table = await ProjectVmBusy.processes()
    expect(table.find((item) => item.pid === process.pid)?.ppid).toBe(process.ppid)
  })
})

describe("ProjectVmBusy.push", () => {
  test("sends the report with the project token", async () => {
    const received: { url: string; authorization: string; body: unknown }[] = []
    const server = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on("data", (chunk: Buffer) => chunks.push(chunk))
      req.on("end", () => {
        received.push({
          url: req.url ?? "",
          authorization: req.headers.authorization ?? "",
          body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
        })
        res.writeHead(204).end()
      })
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const port = (server.address() as { port: number }).port
    const fiber = Effect.runFork(
      ProjectVmBusy.push({
        url: `http://127.0.0.1:${port}/`,
        projectID: "p 1",
        token: "secret",
        intervalMs: 20,
        read: Effect.succeed({ busy: true, reasons: ["sessions:1"] }),
      }),
    )
    while (received.length < 2) await Bun.sleep(10)
    await Effect.runPromise(Fiber.interrupt(fiber))
    server.close()
    expect(received[0]).toEqual({
      url: "/internal/projects/p%201/busy",
      authorization: "Bearer secret",
      body: { busy: true, reasons: ["sessions:1"] },
    })
  })
})
