import { createEffect, createMemo, createSignal, on, onCleanup, Show, type Accessor } from "solid-js"
import { useParams } from "@solidjs/router"
import { Icon } from "@opencode/ui/icon"
import { useLanguage } from "@/runtime/i18n/language"
import { useData } from "@/runtime/server/current"
import { DEFAULT_SHARE } from "@/session/session-panel-width"
import { sessionFormRequest } from "./session-request-tree"
import { PreviewQuestionPanel } from "./preview-question-panel"

// Whether the routed session's questions are answered in the preview panel. The composer then shows no question dock.
const [host, setHost] = createSignal(false)

/** Whether the preview panel answers the routed session's questions, so the composer need not. */
export const questionsInPreview = host

// Bumped by the chat's note to bring a waiting question back to the front.
const [shown, setShown] = createSignal(0)

// The side panel is at least this wide while it shows a question, so the options read comfortably.
const QUESTION_PANEL_MIN = 560

// The pane row's gap between the chat and the side panel.
const GAP = 4

/** The routed session's pending question from the agent, if any. */
export function usePendingQuestion() {
  const params = useParams()
  const data = useData()

  return createMemo(() => {
    const form = sessionFormRequest(data.session.list(), data.session.form.list, params.id)

    return form?.metadata?.kind === "question" ? form : undefined
  })
}

/**
 * Brings the agent's questions to the preview panel, as the old app did: while a question waits, the side panel is
 * open, shows the preview, and is wide enough for it. Runs from the side region, which is mounted on desktop whether
 * the panel is open or not. Without a preview tab (a narrow window, no project, or hidden by an admin) the composer's
 * dock asks instead.
 */
export function usePreviewQuestionHost(input: {
  /** The preview tab's key, when the session has one. */
  preview: Accessor<string | undefined>
  opened: Accessor<boolean>
  open: () => void
  select: (key: string) => void
  /** The pane row the chat and the side panel share, for the width check. */
  row: Accessor<HTMLElement | undefined>
  session: { width: Accessor<number>; resized: Accessor<boolean>; resize: (width: number) => void }
}) {
  const question = usePendingQuestion()

  createEffect(() => {
    setHost(!!input.preview())
    onCleanup(() => setHost(false))
  })

  // The panel stays open while a question waits: closed, the question would have nowhere to show.
  createEffect(() => {
    if (!question() || !input.preview() || input.opened()) return
    input.open()
  })

  // Each new question, and each press of the chat's note, brings the preview to the front and makes room for it.
  createEffect(
    on([() => question()?.id, shown], ([id]) => {
      const key = input.preview()

      if (!id || !key) return

      if (!input.opened()) input.open()
      input.select(key)
      widen(input)
    }),
  )
}

/**
 * Tells the chat why it is waiting while the preview panel holds the agent's question: the composer is hidden until
 * the question is answered, and the note brings the question back if another tab covered it.
 */
export function PreviewQuestionNotice() {
  const question = usePendingQuestion()
  const language = useLanguage()

  return (
    <Show when={questionsInPreview() && question()}>
      <div class="flex items-center justify-center gap-2 px-3 py-2 text-[13px] text-v2-text-text-muted">
        <Icon name="help" size="small" class="shrink-0 text-[#1a64d6]" />
        <span>{language.t("session.question.waitingInPreview")}</span>
        <button
          type="button"
          class="cursor-pointer rounded-[6px] px-1.5 py-0.5 font-[500] text-[#0a3a78] hover:bg-[#1a64d6]/15 dark:text-[#7fb0ff]"
          onClick={() => setShown((count) => count + 1)}
        >
          {language.t("session.question.showInPreview")}
        </button>
      </div>
    </Show>
  )
}

// Narrows the chat when the side panel would be too small for a question; the chat keeps its own minimum.
function widen(input: Parameters<typeof usePreviewQuestionHost>[0]) {
  const available = input.row()?.clientWidth

  if (!available) return

  const chat = input.session.resized()
    ? input.session.width()
    : Math.max(400, Math.round((available - GAP) * DEFAULT_SHARE))

  if (available - chat - GAP >= QUESTION_PANEL_MIN) return
  const next = Math.max(400, available - QUESTION_PANEL_MIN - GAP)

  if (next < chat) input.session.resize(next)
}

/**
 * Covers the side panel's body with the agent's pending question until it is answered or dismissed, whichever section
 * the panel shows. `reveal` puts the panel's header on the preview when a new question arrives.
 */
export function PreviewQuestion(props: { active: Accessor<boolean>; reveal: () => void }) {
  const question = usePendingQuestion()

  createEffect(
    on(
      () => question()?.id,
      (id) => {
        if (id) props.reveal()
      },
    ),
  )

  return (
    <Show when={props.active() && question()} keyed>
      {(request) => (
        <div class="absolute inset-x-0 top-10 bottom-0 z-20 bg-v2-background-bg-base">
          <PreviewQuestionPanel request={request} />
        </div>
      )}
    </Show>
  )
}
