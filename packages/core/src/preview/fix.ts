// The AI fallback: when the preview can't start a project by itself, a hidden setup agent proposes commands and the
// preview tries each one. It stops at the first that runs, after AI_TRIES tries, or at AI_BUDGET, whichever comes first.

import type { Preview } from "@opencode/schema/preview"
import { directoryTree, type Attempt, type Failure, type Fix } from "./controller.js"
import { AI_BUDGET, AI_LOG_TAIL, AI_TRIES } from "./limits.js"

/** The session operations the fallback needs, so it runs the same over real sessions and in tests. */
export interface SetupSessions {
  /** Creates the setup session as a child of `parentID`, returning its ID. */
  create(parentID: string): Promise<string>
  prompt(sessionID: string, text: string): Promise<void>
  /** Resolves when the session goes idle. */
  wait(sessionID: string): Promise<void>
  interrupt(sessionID: string): Promise<void>
  /** The text of the session's last assistant reply. */
  lastText(sessionID: string): Promise<string | undefined>
}

export type TryResult = { ok: boolean; reason: string; log: string }

type Run = {
  attempt: (recipe: Preview.Recipe) => Promise<Attempt>
  tries: number
  succeeded?: Preview.Recipe
  finish: () => void
}

export function createFixer(input: {
  directory: string
  sessions: SetupSessions
  limits?: { tries?: number; budget?: number }
}) {
  const tries = input.limits?.tries ?? AI_TRIES
  const budget = input.limits?.budget ?? AI_BUDGET
  const runs = new Map<string, Run>()

  /** What the `preview_try` tool does for the setup session that calls it. */
  const tryRecipe = async (sessionID: string, recipe: Preview.Recipe): Promise<TryResult> => {
    const run = runs.get(sessionID)

    if (!run) return { ok: false, reason: "preview_try only works while O M A I + is setting up a preview.", log: "" }

    if (run.succeeded) return { ok: true, reason: "The preview is already running.", log: "" }

    if (run.tries >= tries)
      return { ok: false, reason: "No tries are left. Stop and reply with one sentence saying why.", log: "" }
    run.tries++
    const result = await run.attempt({ ...recipe, source: "ai" })

    if (result.ok) {
      run.succeeded = { ...recipe, source: "ai" }
      run.finish()

      return { ok: true, reason: "The preview is running.", log: "" }
    }

    if (run.tries >= tries) run.finish()

    return { ok: false, reason: result.reason, log: result.log.slice(-AI_LOG_TAIL) }
  }

  const fix: Fix = async (failure, attempt, cancel) => {
    if (!failure.sessionID) return { reason: failure.reason }
    const child = await input.sessions.create(failure.sessionID)
    const finished = Promise.withResolvers<void>()
    const run: Run = { attempt, tries: 0, finish: () => finished.resolve() }
    runs.set(child, run)
    const timer = Promise.withResolvers<void>()
    const timeout = setTimeout(() => timer.resolve(), budget)

    try {
      await input.sessions.prompt(child, await prompt(input.directory, failure))
      const outcome = await Promise.race([
        input.sessions.wait(child).then(() => "done" as const),
        finished.promise.then(() => "finished" as const),
        timer.promise.then(() => "timeout" as const),
      ])

      if (outcome !== "done") await input.sessions.interrupt(child).catch(() => undefined)

      if (run.succeeded) return { recipe: run.succeeded }

      if (outcome === "timeout") {
        await cancel()

        return { reason: "It took too long to find a way to start this project." }
      }
      const said = (await input.sessions.lastText(child).catch(() => undefined))
        ?.split("\n")
        .map((line) => line.trim())
        .find(Boolean)

      return { reason: said || "Couldn't find a way to start this project." }
    } finally {
      clearTimeout(timeout)
      runs.delete(child)
    }
  }

  return { fix, tryRecipe }
}

const MAX_ENTRIES = 300

const MAX_PACKAGES = 10

const MAX_PACKAGE_SIZE = 4096

// The setup agent's first message: what failed, the end of the log, the layout and every package.json.
async function prompt(directory: string, failure: Failure) {
  const tree = directoryTree(directory)
  const files: string[] = []
  const packages: string[] = []
  const queue = [{ dir: ".", depth: 0 }]

  for (let next = queue.shift(); next && files.length < MAX_ENTRIES; next = queue.shift()) {
    const entries = [...(await tree.list(next.dir))].sort((a, b) => a.name.localeCompare(b.name))

    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue
      const file = next.dir === "." ? entry.name : `${next.dir}/${entry.name}`
      files.push(entry.dir ? `${file}/` : file)

      if (entry.dir && next.depth < 2) queue.push({ dir: file, depth: next.depth + 1 })

      if (entry.name === "package.json" && packages.length < MAX_PACKAGES) packages.push(file)
    }
  }
  const contents = await Promise.all(
    packages.map(
      async (file) => `### ${file}\n\`\`\`json\n${((await tree.read(file)) ?? "").slice(0, MAX_PACKAGE_SIZE)}\n\`\`\``,
    ),
  )

  return [
    "O M A I + couldn't start this project's preview by itself.",
    "",
    `What went wrong (${failure.step}): ${failure.reason}`,
    "",
    "The end of the log:",
    "```",
    failure.log.slice(-AI_LOG_TAIL) || "(empty)",
    "```",
    "",
    "The project's files, three levels deep:",
    "```",
    files.join("\n") || "(no files)",
    "```",
    "",
    ...(contents.length > 0 ? ["The package.json files:", "", ...contents, ""] : []),
    `Find the command that starts this project's development server and call preview_try with it. You have ${AI_TRIES} tries.`,
  ].join("\n")
}
