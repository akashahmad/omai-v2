import { spawn } from "node:child_process"
import type { GitTool } from "@opencode/schema/git-tool"
import { gitExecutable } from "../util/git-executable.js"

export function runGit(input: { cwd: string; args: string[]; env?: Record<string, string>; timeout?: number }) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(gitExecutable(), input.args, {
      cwd: input.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      // Without a controlling terminal ssh cannot ask for a passphrase or host confirmation on /dev/tty.
      detached: process.platform !== "win32",
      env: {
        GIT_SSH_COMMAND: "ssh -o BatchMode=yes",
        ...process.env,
        ...input.env,
        GIT_TERMINAL_PROMPT: "0",
        GIT_ASKPASS: "",
        SSH_ASKPASS: "",
      },
    })
    const out: Buffer[] = []
    const err: Buffer[] = []
    const finish = (code: number) =>
      resolve({ code, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") })
    // Resolve here rather than on close: a killed git can leave a grandchild holding the pipes open.
    const timer = setTimeout(() => {
      // The whole group: a killed git leaves ssh or a hook running otherwise.
      if (child.pid && process.platform !== "win32") {
        // The group may already be gone when only a pipe was left open.
        try {
          process.kill(-child.pid, "SIGKILL")
        } catch {}
      } else child.kill("SIGKILL")
      finish(124)
    }, input.timeout ?? 120_000)

    child.stdout.on("data", (chunk: Buffer) => out.push(chunk))
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk))
    child.on("error", (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      finish(code ?? 1)
    })
  })
}

const kinds = [
  ["auth", /could not read (Username|Password)|Authentication failed|Permission denied \(publickey|terminal prompts disabled|HTTP 40[13]/i],
  ["diverged", /non-fast-forward|\[rejected\]|Not possible to fast-forward|divergent branches|fetch first/i],
  ["conflict", /CONFLICT|merge conflict|Resolve all conflicts|unmerged files/i],
  ["no-upstream", /no upstream branch|no tracking information/i],
  ["no-remote", /No configured push destination|No such remote|no remote|does not appear to be a git repository/i],
  ["nothing-to-commit", /nothing (added )?to commit|no changes added to commit/i],
  ["not-a-repo", /not a git repository/i],
  ["no-profile", /Author identity unknown|Please tell me who you are|unable to auto-detect email/i],
] as const satisfies readonly (readonly [GitTool.FailureKind, RegExp])[]

export function classify(stderr: string): GitTool.FailureKind {
  return kinds.find(([, pattern]) => pattern.test(stderr))?.[0] ?? "other"
}
