import { describe, expect, test } from "bun:test"
import { createVisual } from "./session"
import type { ElementInfo, LiveChange, PageMessage } from "./protocol"

const element: ElementInfo = {
  path: "p",
  fingerprint: { tag: "p", classes: [], attrs: {}, index: 1 },
  label: "Text",
  tag: "p",
  rect: { x: 0, y: 0, width: 1, height: 1 },
  styles: {},
  isText: true,
  plainText: true,
  isImage: false,
  layout: "block",
  breadcrumb: [],
}

const change: LiveChange = { path: "p", fingerprint: element.fingerprint, kind: "style", property: "color", before: "red", after: "blue" }

function setup(options: { busy?: boolean; prompt?: (text: string) => Promise<void> } = {}) {
  const posted: PageMessage[] = []
  const prompts: string[] = []
  const state = { busy: options.busy ?? false }

  const visual = createVisual({
    post: (message) => posted.push(message),
    running: () => true,
    prompt: options.prompt ?? (async (text) => void prompts.push(text)),
    agentBusy: () => state.busy,
    interrupt: async () => {},
    ask: () => {},
    image: () => {},
    page: () => "/",
    labels: () => ({}),
  })

  const commands = () =>
    posted.map((message) => (message.type === "omai:visual" ? `bridge:${message.action}` : message.command.name))

  return { visual, posted, prompts, state, commands }
}

describe("visual editing state", () => {
  test("toggle loads and enables, then disables and keeps pending", () => {
    const view = setup()
    view.visual.toggle()

    expect(view.visual.enabled()).toBe(true)
    expect(view.commands()).toEqual(["bridge:load", "enable"])
    view.visual.handle({ type: "omai:visual:change", v: 1, change })
    view.visual.toggle()

    expect(view.visual.enabled()).toBe(false)
    expect(view.commands().at(-1)).toBe("disable")
    expect(view.visual.pending().items).toEqual([change])
  })

  test("re-applies pending after ready", () => {
    const view = setup()
    view.visual.toggle()
    view.visual.handle({ type: "omai:visual:change", v: 1, change })
    view.visual.handle({ type: "omai:visual:ready", v: 1, fonts: ["Inter"], colors: ["rgb(0, 0, 0)"] })
    expect(view.posted.at(-1)).toEqual({ type: "omai:visual:command", v: 1, command: { name: "apply", changes: [change] } })
    expect(view.visual.fonts()).toEqual(["Inter"])
  })

  test("save sends one prompt and clears after the agent finishes", async () => {
    const view = setup()
    view.visual.handle({ type: "omai:visual:change", v: 1, change })
    await view.visual.save()

    expect(view.prompts).toHaveLength(1)
    expect(view.visual.saving()).toBe("working")
    view.visual.agentChanged(true)
    view.visual.agentChanged(false)

    expect(view.visual.saving()).toBe("idle")
    expect(view.visual.pending().items).toEqual([])
  })

  test("save is blocked while the agent is busy", async () => {
    const view = setup({ busy: true })
    view.visual.handle({ type: "omai:visual:change", v: 1, change })

    expect(view.visual.canSave()).toBe(false)
    expect(view.visual.blockedReason()).toBe("busy")
    await view.visual.save()

    expect(view.prompts).toEqual([])
  })

  test("a failed prompt keeps the changes and reports the error", async () => {
    const view = setup({ prompt: () => Promise.reject(new Error("offline")) })
    view.visual.handle({ type: "omai:visual:change", v: 1, change })
    await view.visual.save()

    expect(view.visual.saving()).toBe("error")
    expect(view.visual.saveError()).toBe("offline")
    expect(view.visual.pending().items).toEqual([change])
  })

  test("undo reverts the last change in the page", () => {
    const view = setup()
    view.visual.toggle()
    view.visual.handle({ type: "omai:visual:change", v: 1, change })
    view.visual.undo()

    expect(view.visual.pending().items).toEqual([])
    expect(view.posted.at(-1)).toMatchObject({ command: { name: "revert", change } })
  })
})
