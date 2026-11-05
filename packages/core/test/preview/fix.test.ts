import { describe, expect, test } from "bun:test"
import type { Preview } from "@opencode/schema/preview"
import type { Attempt, Failure } from "@opencode/core/preview/controller"
import { createFixer, type SetupSessions } from "@opencode/core/preview/fix"

const failure: Failure = { step: "detect", reason: "No web app was found.", log: "", sessionID: "ses_parent" }

const recipe = (command: string): Preview.Recipe => ({ root: ".", kind: "command", command, source: "ai" })

// A stand-in for the setup agent: on its prompt it calls the tool with each command in turn, then finishes.
function agent(commands: string[], options: { pauseMs?: number } = {}) {
  const state = {
    created: 0,
    interrupted: [] as string[],
    tool: undefined as undefined | ((sessionID: string, recipe: Preview.Recipe) => Promise<unknown>),
  }
  const done = new Map<string, () => void>()
  const sessions: SetupSessions = {
    create: async () => `ses_child_${++state.created}`,
    prompt: async (sessionID) => {
      void (async () => {
        for (const command of commands) {
          if (state.interrupted.includes(sessionID)) break
          await state.tool!(sessionID, recipe(command))
          if (options.pauseMs) await Bun.sleep(options.pauseMs)
        }
        done.get(sessionID)?.()
      })()
    },
    wait: (sessionID) => new Promise((resolve) => done.set(sessionID, resolve)),
    interrupt: async (sessionID) => {
      state.interrupted.push(sessionID)
      done.get(sessionID)?.()
    },
    lastText: async () => "The project needs a build step I can't run.",
  }
  return { sessions, state }
}

function setup(commands: string[], options: { pauseMs?: number; budget?: number } = {}) {
  const fake = agent(commands, options)
  const fixer = createFixer({
    directory: "/tmp/project",
    sessions: fake.sessions,
    limits: { budget: options.budget },
  })
  fake.state.tool = (sessionID, value) => fixer.tryRecipe(sessionID, value)
  return { fixer, state: fake.state }
}

// Runs the command "good" successfully and anything else as a failure; "slow" never finishes on its own.
function attempts() {
  const tried: string[] = []
  const cancelled = { value: false }
  const attempt = async (value: Preview.Recipe): Promise<Attempt> => {
    tried.push(value.command ?? "")
    if (value.command === "slow") {
      while (!cancelled.value) await Bun.sleep(20)
      return { ok: false, reason: "cancelled", log: "" }
    }
    return value.command === "good" ? { ok: true } : { ok: false, reason: "exited", log: "boom" }
  }
  return { tried, cancelled, attempt, cancel: async () => void (cancelled.value = true) }
}

describe("createFixer", () => {
  test("succeeds on the second try", async () => {
    const { fixer } = setup(["bad", "good"])
    const run = attempts()
    const result = await fixer.fix(failure, run.attempt, run.cancel)

    expect(result).toEqual({ recipe: recipe("good") })
    expect(run.tried).toEqual(["bad", "good"])
  })

  test("stops at three tries", async () => {
    const { fixer, state } = setup(["a", "b", "c", "d"])
    const run = attempts()
    const result = await fixer.fix(failure, run.attempt, run.cancel)

    expect(run.tried).toEqual(["a", "b", "c"])
    expect("reason" in result).toBe(true)
    expect(state.interrupted.length).toBe(1)
  })

  test("stops at the time budget, mid-start", async () => {
    const { fixer, state } = setup(["slow"], { budget: 300 })
    const run = attempts()
    const started = Date.now()
    const result = await fixer.fix(failure, run.attempt, run.cancel)

    expect("reason" in result && result.reason).toContain("too long")
    expect(run.cancelled.value).toBe(true)
    expect(state.interrupted.length).toBe(1)
    expect(Date.now() - started).toBeLessThan(6_000)
  })

  test("reports the agent's reason when nothing worked", async () => {
    const { fixer } = setup(["bad"])
    const run = attempts()

    expect(await fixer.fix(failure, run.attempt, run.cancel)).toEqual({
      reason: "The project needs a build step I can't run.",
    })
  })

  test("refuses the tool outside a setup session", async () => {
    const { fixer } = setup([])

    expect(await fixer.tryRecipe("ses_someone_else", recipe("good"))).toMatchObject({ ok: false })
  })

  test("does nothing without a session to attach to", async () => {
    const { fixer, state } = setup(["good"])
    const run = attempts()
    const result = await fixer.fix({ ...failure, sessionID: undefined }, run.attempt, run.cancel)

    expect(result).toEqual({ reason: failure.reason })
    expect(state.created).toBe(0)
  })
})
