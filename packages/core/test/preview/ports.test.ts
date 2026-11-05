import { describe, expect, test } from "bun:test"
import { logPorts } from "@opencode/core/preview/ports"

describe("logPorts", () => {
  test("finds a port behind colour codes", () => {
    expect(logPorts("\x1b[32m  Local: http://localhost:\x1b[1m5173\x1b[0m/")).toEqual([5173])
  })

  test("ignores privileged ports and repeats", () => {
    expect(logPorts("http://localhost:80 http://127.0.0.1:3000 http://0.0.0.0:3000 [::1]:4321")).toEqual([3000, 4321])
  })
})
