// One session's visual editing: whether it is on, what is selected in the preview, the pending changes and the save.
// It talks to the editor in the preview page through `post`; the preview view owns the frame and routes the page's
// decoded messages to `handle`. No effects live here: the view tells it when the agent's activity changes.

import { batch, createSignal, type Accessor } from "solid-js"
import { empty, record, redo, remove, undo, type Pending } from "./changes"
import {
  command,
  type Command,
  type ElementInfo,
  type LiveChange,
  type PageMessage,
  type SourceHint,
  type VisualMessage,
} from "./protocol"
import { savePrompt } from "./prompt"

export type SavePhase = "idle" | "sending" | "working" | "error"

export type VisualInput = {
  /** Posts a message to the preview page. */
  post: (message: PageMessage) => void
  running: Accessor<boolean>
  /** Sends a prompt to the session's agent. */
  prompt: (text: string) => Promise<void>
  agentBusy: Accessor<boolean>
  interrupt: () => Promise<void>
  /** Attaches the element to the composer, for a change described in words. */
  ask: (element: ElementInfo) => void
  /** Opens the replace-image dialog for the element. */
  image: (element: ElementInfo) => void
  /** The page on screen, for the prompt. */
  page: Accessor<string>
  /** The in-page mini-toolbar's tooltips, in the app's language. */
  labels: Accessor<Record<string, string>>
}

export type Visual = ReturnType<typeof createVisual>

export function createVisual(input: VisualInput) {
  const [enabled, setEnabled] = createSignal(false)
  const [selected, setSelected] = createSignal<ElementInfo>()
  const [fonts, setFonts] = createSignal<readonly string[]>([])
  const [colors, setColors] = createSignal<readonly string[]>([])
  const [pending, setPending] = createSignal<Pending>(empty())
  const [saving, setSaving] = createSignal<SavePhase>("idle")
  const [saveError, setSaveError] = createSignal<string>()
  const [startedAt, setStartedAt] = createSignal<number>()
  const hints = new Map<string, SourceHint | undefined>()
  const watch = { sawBusy: false }

  const send = (value: Command) => input.post(command(value))
  const load = () => input.post({ type: "omai:visual", action: "load" })

  const enter = () => {
    if (!input.running() || enabled()) return
    setEnabled(true)
    load()
    send({ name: "enable", labels: input.labels() })
  }

  const exit = () => {
    if (!enabled()) return
    batch(() => {
      setEnabled(false)
      setSelected(undefined)
    })
    send({ name: "disable" })
  }

  const apply = (changes: readonly LiveChange[]) => changes.length > 0 && send({ name: "apply", changes })

  const blockedReason = () => {
    if (pending().items.length === 0) return "empty" as const

    if (input.agentBusy() || saving() === "sending" || saving() === "working") return "busy" as const

    return undefined
  }

  return {
    enabled,
    selected,
    fonts,
    colors,
    pending,
    saving,
    saveError,
    startedAt,
    toggle: () => (enabled() ? exit() : enter()),
    exit,
    /** Called on every page load in the frame: the editor has to be loaded again after a reload. */
    pageLoaded: () => enabled() && load(),
    handle: (message: VisualMessage) => {
      if (message.type === "omai:visual:loaded" && enabled()) send({ name: "enable", labels: input.labels() })

      if (message.type === "omai:visual:ready")
        batch(() => {
          setFonts(message.fonts)
          setColors(message.colors)
          apply(pending().items)
        })

      if (message.type === "omai:visual:select") {
        if (message.element) hints.set(message.element.path, message.element.source)
        setSelected(message.element ?? undefined)
      }

      if (message.type === "omai:visual:change") setPending((current) => record(current, message.change))

      if (message.type === "omai:visual:ask") input.ask(message.element)

      if (message.type === "omai:visual:image") input.image(message.element)
    },
    /** Attaches the element to the composer. */
    ask: (element: ElementInfo) => input.ask(element),
    /** Opens the replace-image dialog for the element. */
    image: (element: ElementInfo) => input.image(element),
    style: (property: string, value: string) => send({ name: "style", property, value }),
    text: (value: string) => send({ name: "text", value }),
    attribute: (attr: "src" | "alt" | "href" | "title", value: string) => send({ name: "attribute", attr, value }),
    move: (delta: -1 | 1) => send({ name: "move", delta }),
    selectPath: (path: string) => send({ name: "select", path }),
    parent: () => send({ name: "parent" }),
    undo: () => {
      const result = undo(pending())
      setPending(result.pending)
      result.revert.forEach((change) => send({ name: "revert", change }))
      apply(result.apply)
    },
    redo: () => {
      const result = redo(pending())
      setPending(result.pending)
      apply(result.apply)
    },
    removeAt: (index: number) => {
      const result = remove(pending(), index)
      setPending(result.pending)

      if (result.revert) send({ name: "revert", change: result.revert })
    },
    discard: () => {
      pending().items.toReversed().forEach((change) => send({ name: "revert", change }))
      setPending(empty())
    },
    canSave: () => blockedReason() === undefined,
    blockedReason,
    save: async () => {
      if (blockedReason() !== undefined) return
      const text = savePrompt({ page: input.page(), items: pending().items, hints })
      batch(() => {
        setSaving("sending")
        setSaveError(undefined)
        setStartedAt(Date.now())
      })
      watch.sawBusy = false

      await input.prompt(text).then(
        () => setSaving("working"),
        (error: { readonly message?: string } | undefined) =>
          batch(() => {
            setSaving("error")
            setSaveError(error?.message ?? "")
          }),
      )
    },
    stopSave: () => {
      setSaving("idle")
      void input.interrupt().catch(() => undefined)
    },
    /** The agent went busy or idle. A save is done once the agent went busy for it and is idle again. */
    agentChanged: (busy: boolean) => {
      if (saving() !== "working") return

      if (busy) {
        watch.sawBusy = true

        return
      }

      if (!watch.sawBusy) return
      batch(() => {
        setSaving("idle")
        setPending(empty())
      })
    },
  }
}
