import { describe, expect, test } from "bun:test"
import { createServer } from "node:net"
import path from "node:path"
import { LogBuffer, spawnGroup, waitReady } from "@opencode/core/preview/process"

const fake = path.join(import.meta.dir, "fixtures", "fake-server.mjs")

async function freePort() {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  await new Promise((resolve) => server.close(resolve))
  return typeof address === "object" && address ? address.port : 0
}

async function run(mode: string, timeout?: number) {
  const port = await freePort()
  const log = new LogBuffer()
  const running = spawnGroup({
    command: `node ${JSON.stringify(fake)}`,
    cwd: import.meta.dir,
    env: { ...process.env, MODE: mode, PORT: String(port) } as Record<string, string>,
    onLog: (chunk) => log.append(chunk),
  })
  const controller = new AbortController()
  const ready = await waitReady({ running, assigned: port, log: () => log.text(), signal: controller.signal, timeout })
  return { port, log, running, ready }
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe("waitReady", () => {
  test("ready on the assigned port", async () => {
    const { port, running, ready } = await run("env-port")
    await running.stop()

    expect(ready).toEqual({ ok: true, port })
  })

  test("finds a port the server picked itself", async () => {
    const { port, running, ready } = await run("own-port")
    await running.stop()

    expect(ready.ok).toBe(true)
    expect(ready.ok && ready.port).not.toBe(port)
    expect(ready.ok && ready.port).not.toBe(9)
  })

  test("finds the port behind colour codes", async () => {
    const { port, running, ready } = await run("ansi")
    await running.stop()

    expect(ready).toEqual({ ok: true, port })
  })

  test("fails fast when the process exits", async () => {
    const started = Date.now()
    const { ready } = await run("exit")

    expect(ready.ok).toBe(false)
    expect(!ready.ok && ready.reason).toContain("exited")
    expect(Date.now() - started).toBeLessThan(2_000)
  })

  test("finds a grandchild's port", async () => {
    const { running, ready } = await run("child")
    await running.stop()

    expect(ready.ok).toBe(true)
  })

  test("times out when nothing listens", async () => {
    const { running, ready } = await run("never", 1_000)
    await running.stop()

    expect(ready.ok).toBe(false)
    expect(!ready.ok && ready.reason).toContain("didn't start")
  })
})

describe("spawnGroup", () => {
  test("stop kills the whole group", async () => {
    const { running, log, ready } = await run("child")
    const child = Number(/child:(\d+)/.exec(log.text())?.[1])
    await running.stop()

    expect(ready.ok).toBe(true)
    expect(alive(running.pid)).toBe(false)
    expect(alive(child)).toBe(false)
  })
})

describe("LogBuffer", () => {
  test("keeps only the last 256 KB", () => {
    const log = new LogBuffer()
    log.append("a".repeat(200 * 1024))
    log.append("b".repeat(100 * 1024))

    expect(log.text().length).toBe(256 * 1024)
    expect(log.text().endsWith("b")).toBe(true)
    expect(log.tail(3)).toBe("bbb")
  })
})
