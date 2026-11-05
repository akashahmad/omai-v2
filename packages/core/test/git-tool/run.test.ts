import fs from "node:fs/promises"
import path from "node:path"
import { describe, expect, test } from "bun:test"
import { classify, runGit } from "../../src/git-tool/run"
import { tmpdir } from "../fixture/tmpdir"

describe("runGit", () => {
  test("runs git init in a temp dir", async () => {
    await using tmp = await tmpdir()
    const result = await runGit({ cwd: tmp.path, args: ["init"] })
    expect(result.code).toBe(0)
  })

  test("returns non-zero instead of prompting for credentials", async () => {
    await using tmp = await tmpdir()
    const started = Date.now()
    const result = await runGit({ cwd: tmp.path, args: ["ls-remote", "https://127.0.0.1:9/x.git"] })
    expect(result.code).not.toBe(0)
    expect(Date.now() - started).toBeLessThan(10_000)
  })

  test("keeps prompting disabled even when the caller passes GIT_TERMINAL_PROMPT", async () => {
    await using tmp = await tmpdir()
    const result = await runGit({
      cwd: tmp.path,
      args: ["-c", "alias.e=!printenv GIT_TERMINAL_PROMPT", "e"],
      env: { GIT_TERMINAL_PROMPT: "1" },
    })
    expect(result.stdout.trim()).toBe("0")
  })

  test("kills a command that exceeds the timeout with code 124", async () => {
    await using tmp = await tmpdir()
    const result = await runGit({ cwd: tmp.path, args: ["-c", "alias.slow=!sleep 5", "slow"], timeout: 200 })
    expect(result.code).toBe(124)
  })

  test("a timeout kills the whole process group, not only git", async () => {
    await using tmp = await tmpdir()
    const pidfile = path.join(tmp.path, "pid")
    const result = await runGit({
      cwd: tmp.path,
      args: ["-c", `alias.slow=!sh -c 'sleep 30 & echo $! > "${pidfile}"; wait'`, "slow"],
      timeout: 1000,
    })
    expect(result.code).toBe(124)
    const pid = Number((await fs.readFile(pidfile, "utf8")).trim())
    expect(pid).toBeGreaterThan(0)
    await Bun.sleep(100)
    expect(() => process.kill(pid, 0)).toThrow()
  })

  test("defaults ssh to batch mode unless the caller sets it", async () => {
    await using tmp = await tmpdir()
    const read = (env?: Record<string, string>) =>
      runGit({ cwd: tmp.path, args: ["-c", "alias.e=!printenv GIT_SSH_COMMAND", "e"], env })
    expect((await read()).stdout.trim()).toBe(process.env.GIT_SSH_COMMAND ?? "ssh -o BatchMode=yes")
    expect((await read({ GIT_SSH_COMMAND: "ssh -v" })).stdout.trim()).toBe("ssh -v")
  })
})

describe("classify", () => {
  test.each([
    ["fatal: could not read Username for 'https://github.com'", "auth"],
    ["! [rejected] main -> main (non-fast-forward)", "diverged"],
    ["CONFLICT (content)", "conflict"],
    ["has no upstream branch", "no-upstream"],
    ["nothing to commit", "nothing-to-commit"],
    ["not a git repository", "not-a-repo"],
    ["something else", "other"],
  ] as const)("%s -> %s", (stderr, kind) => {
    expect(classify(stderr)).toBe(kind)
  })
})
