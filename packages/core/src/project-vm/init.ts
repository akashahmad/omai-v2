import { execFile } from "node:child_process"
import { access, mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { promisify } from "node:util"

const run = promisify(execFile)

const AUTHOR = {
  GIT_AUTHOR_NAME: "O M A I +",
  GIT_AUTHOR_EMAIL: "noreply@omai.ch",
  GIT_COMMITTER_NAME: "O M A I +",
  GIT_COMMITTER_EMAIL: "noreply@omai.ch",
}

const marker = (input: { home: string; slug: string }) => path.join(input.home, ".omai", "initialized", input.slug)
const exists = (file: string) =>
  access(file).then(
    () => true,
    () => false,
  )

export function initialized(input: { home: string; slug: string }) {
  return exists(marker(input))
}

/**
 * Prepares `<home>/<slug>` once: creates it, and when it is not already a git repository, initialises one on `main`
 * with a first commit by O M A I +. A marker under `<home>/.omai/initialized` makes later calls no-ops.
 */
export async function init(input: { home: string; slug: string }) {
  const directory = path.join(input.home, input.slug)
  await mkdir(directory, { recursive: true })
  if (await initialized(input)) return { directory, created: false }
  if (!(await exists(path.join(directory, ".git")))) {
    const git = (...args: string[]) =>
      run("git", ["-c", "commit.gpgsign=false", ...args], { cwd: directory, env: { ...process.env, ...AUTHOR } })
    await git("init", "-b", "main")
    await git("add", "-A")
    await git("commit", "--allow-empty", "--no-verify", "-m", "Initial commit")
  }
  await mkdir(path.dirname(marker(input)), { recursive: true })
  await writeFile(marker(input), new Date().toISOString())
  return { directory, created: true }
}
