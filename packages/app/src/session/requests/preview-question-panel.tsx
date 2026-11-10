import { For, Show, createMemo, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { useMutation } from "@tanstack/solid-query"
import type { FormAnswer, FormInfo, FormMultiselectField, FormStringField } from "@opencode/client/promise"
import { BrandIcon } from "@/shell/brand-icon"
import { showToast } from "@/shell/notifications/toast"
import { useLanguage } from "@/runtime/i18n/language"
import { useServerSDK } from "@/runtime/server/client"
import { ScopedKey } from "@/runtime/server/scope"
import { questionCache } from "./question-state"

type QuestionField = FormStringField | FormMultiselectField

// The answers in progress, per question by index.
type Draft = { tab: number; answers: string[][]; custom: string[]; customOn: boolean[]; editing: boolean }

// The brand blue, from deep to light, as the gradient on the panel's title, question and primary button.
const GRADIENT = "linear-gradient(135deg, #082f62 0%, #0a3a78 35%, #38bdf8 100%)"

const TEXT_GRADIENT = {
  background: GRADIENT,
  "-webkit-background-clip": "text",
  "background-clip": "text",
  color: "transparent",
}

const PICKED = "border-[#1a64d6] shadow-[0_0_0_1px_#1a64d6,0_2px_8px_-3px_#1a64d6]"

const UNPICKED = "border-v2-border-border-base hover:border-v2-border-border-strong hover:bg-v2-background-bg-layer-01"

/**
 * The agent's questions, shown in the preview panel in place of the running app until they are answered or dismissed.
 * One question at a time, with its options as cards and an answer of your own below them.
 */
export function PreviewQuestionPanel(props: { request: FormInfo; agent?: string }) {
  const serverSDK = useServerSDK()
  const language = useLanguage()
  const cacheKey = ScopedKey.from(serverSDK.scope, props.request.id)
  const cached = questionCache.get(cacheKey)

  const questions = createMemo(() =>
    props.request.fields
      .filter((field): field is QuestionField => field.type === "string" || field.type === "multiselect")
      .map((field) => ({
        field,
        question: field.description ?? field.title ?? "",
        options: field.type === "string" ? (field.options ?? []) : field.options,
        multiple: field.type === "multiselect",
      })),
  )

  const [store, setStore] = createStore<Draft>({
    tab: cached?.tab ?? 0,
    answers: cached?.answers ?? [],
    custom: cached?.custom ?? [],
    customOn: cached?.customOn ?? [],
    editing: false,
  })

  let replied = false

  // Answers in progress survive the panel closing, e.g. on a switch to another session and back.
  onCleanup(() => {
    if (replied) return
    questionCache.set(cacheKey, {
      tab: store.tab,
      answers: store.answers.map((answer) => (answer ? [...answer] : [])),
      custom: store.custom.map((value) => value ?? ""),
      customOn: store.customOn.map((value) => value ?? false),
    })
  })

  const question = createMemo(() => questions()[store.tab])
  const options = createMemo(() => question()?.options ?? [])
  const multi = createMemo(() => question()?.multiple === true)
  const total = createMemo(() => questions().length)
  const last = createMemo(() => store.tab >= total() - 1)
  const input = () => store.custom[store.tab] ?? ""
  const on = () => store.customOn[store.tab] === true

  const answered = (index: number) => {
    if ((store.answers[index]?.length ?? 0) > 0) return true

    return store.customOn[index] === true && (store.custom[index] ?? "").trim().length > 0
  }

  const answeredCount = createMemo(() => questions().filter((_, index) => answered(index)).length)

  const fail = (error: Error) => showToast({ title: language.t("common.requestFailed"), description: error.message })

  const done = () => {
    replied = true
    questionCache.delete(cacheKey)
  }

  const replyMutation = useMutation(() => ({
    mutationFn: (answer: FormAnswer) =>
      serverSDK.api.session.form.reply({ sessionID: props.request.sessionID, formID: props.request.id, answer }),
    onSuccess: done,
    onError: fail,
  }))

  const rejectMutation = useMutation(() => ({
    mutationFn: () =>
      serverSDK.api.session.form.cancel({ sessionID: props.request.sessionID, formID: props.request.id }),
    onSuccess: done,
    onError: fail,
  }))

  const sending = createMemo(() => replyMutation.isPending || rejectMutation.isPending)

  const picked = (value: string) => store.answers[store.tab]?.includes(value) ?? false

  const customUpdate = (value: string, selected: boolean = on()) => {
    const previous = input().trim()
    const next = value.trim()

    setStore("custom", store.tab, value)

    if (!selected) return

    if (multi()) {
      setStore("answers", store.tab, (current = []) => {
        const removed = previous ? current.filter((item) => item.trim() !== previous) : current

        if (!next || removed.some((item) => item.trim() === next)) return removed

        return [...removed, next]
      })

      return
    }

    setStore("answers", store.tab, next ? [next] : [])
  }

  const select = (value: string) => {
    if (sending()) return
    setStore("editing", false)

    if (multi()) {
      setStore("answers", store.tab, (current = []) =>
        current.includes(value) ? current.filter((item) => item !== value) : [...current, value],
      )

      return
    }

    setStore("customOn", store.tab, false)
    setStore("answers", store.tab, [value])
  }

  const customToggle = () => {
    if (sending()) return

    if (!multi() || !on()) {
      setStore("customOn", store.tab, true)
      setStore("editing", true)
      customUpdate(input(), true)

      return
    }

    setStore("customOn", store.tab, false)
    const value = input().trim()

    if (value) setStore("answers", store.tab, (current = []) => current.filter((item) => item.trim() !== value))
    setStore("editing", false)
  }

  const customOpen = () => {
    if (sending()) return

    if (!on()) setStore("customOn", store.tab, true)
    setStore("editing", true)
    customUpdate(input(), true)
  }

  const commitCustom = () => {
    setStore("editing", false)
    customUpdate(input())
  }

  const resize = (element: HTMLTextAreaElement) => {
    element.style.height = "0px"
    element.style.height = `${element.scrollHeight}px`
  }

  const submit = () =>
    replyMutation.mutate(
      Object.fromEntries(
        questions().flatMap((item, index) => {
          const answers = store.answers[index] ?? []

          if (answers.length === 0) return []

          return [[item.field.key, item.multiple ? answers : answers[0]]]
        }),
      ),
    )

  const next = () => {
    if (sending()) return

    if (store.editing) commitCustom()

    if (last()) return submit()
    setStore("tab", store.tab + 1)
    setStore("editing", false)
  }

  const primaryEnabled = () => (last() ? answeredCount() === total() : answered(store.tab))

  return (
    <div data-component="preview-question-panel" class="flex h-full w-full flex-col overflow-hidden">
      <div class="relative h-1 shrink-0 overflow-hidden bg-v2-background-bg-layer-02">
        <div
          class="h-full transition-[width] duration-500 ease-out"
          style={{
            width: `${total() === 0 ? 0 : (answeredCount() / total()) * 100}%`,
            background: GRADIENT,
          }}
        />
      </div>
      <div
        class="no-scrollbar relative flex-1 overflow-y-auto bg-v2-background-bg-base"
        style={{
          "background-image":
            "radial-gradient(circle, color-mix(in srgb, var(--v2-text-text-faint) 40%, transparent) 0.8px, transparent 0.8px)",
          "background-size": "24px 24px",
        }}
      >
        <div class="relative mx-auto w-full max-w-lg px-5 py-8">
          <div class="mb-9 flex items-center gap-6">
            <div class="flex shrink-0 items-center gap-3.5">
              <span class="relative inline-flex shrink-0 items-center justify-center">
                <span
                  class="pointer-events-none absolute inset-0 -m-2.5 rounded-full opacity-50 blur-xl"
                  style={{ background: "radial-gradient(circle, rgba(10, 58, 120, 0.4), transparent 70%)" }}
                />
                <span
                  class="absolute inset-0 -m-1 rounded-[10px] opacity-30 blur-sm"
                  style={{ background: "linear-gradient(135deg, rgba(10, 58, 120, 0.25), rgba(56, 189, 248, 0.12))" }}
                />
                <BrandIcon class="relative block size-8 rounded-[7px] shadow-[0_0_0_1px_rgba(0,0,0,0.06),0_2px_8px_rgba(0,0,0,0.08)]" />
              </span>
              <div class="min-w-0">
                <span
                  class="block text-[12px] leading-none font-[600] tracking-[0.15em] uppercase"
                  style={TEXT_GRADIENT}
                >
                  {language.t("ui.tool.questions")}
                </span>
                <span class="mt-1 block text-[11px] leading-none font-[500] text-v2-text-text-base">
                  {language.t("session.question.answeredProgress", { answered: answeredCount(), total: total() })}
                </span>
              </div>
            </div>
            <div
              class="h-px flex-1 rounded-full"
              style={{ background: "linear-gradient(90deg, #0a3a78, transparent)" }}
            />
            <span
              class="flex max-w-[160px] shrink-0 items-center gap-1.5 truncate rounded-[8px] border border-[#1a64d6]/25 px-3 py-1 text-[13px] font-[600] text-[#0a3a78] dark:text-[#7fb0ff]"
              title={props.agent}
            >
              <svg viewBox="0 0 16 16" fill="none" class="size-3.5 shrink-0">
                <rect x="1" y="1" width="6" height="6" rx="1.5" stroke="currentColor" stroke-width="1.2" />
                <rect x="9" y="1" width="6" height="6" rx="1.5" stroke="currentColor" stroke-width="1.2" />
                <rect x="1" y="9" width="6" height="6" rx="1.5" stroke="currentColor" stroke-width="1.2" />
                <rect x="9" y="9" width="6" height="6" rx="1.5" stroke="currentColor" stroke-width="1.2" />
              </svg>
              <span class="truncate">
                {props.agent ?? `${String(store.tab + 1).padStart(2, "0")}/${String(total()).padStart(2, "0")}`}
              </span>
            </span>
          </div>

          <div class="relative mb-6 pl-1">
            <div
              class="absolute top-1 bottom-1 left-0 w-[3px] rounded-full"
              style={{ background: "linear-gradient(180deg, #0a3a78 0%, rgba(10, 58, 120, 0.25) 100%)" }}
            />
            <h2
              class="m-0 mb-1.5 ml-5 pr-4 text-[16px] leading-snug font-[500] tracking-[-0.01em]"
              style={TEXT_GRADIENT}
            >
              {question()?.question}
            </h2>
            <p class="mt-0.5 ml-5 text-[13px] text-v2-text-text-base">
              {language.t(multi() ? "ui.question.multiHint" : "ui.question.singleHint")}
            </p>
          </div>

          <div class="flex flex-col gap-2">
            <For each={options()}>
              {(option) => (
                <button
                  type="button"
                  class={`relative flex w-full cursor-pointer items-start gap-2.5 rounded-[8px] border bg-v2-background-bg-base px-3 py-2.5 text-left transition-all duration-200 ${picked(option.value) ? PICKED : `${UNPICKED} shadow-sm`}`}
                  disabled={sending()}
                  onClick={() => select(option.value)}
                >
                  <Mark checked={picked(option.value)} />
                  <span class="min-w-0 flex-1">
                    <span class="block text-[14px] leading-snug font-[500] break-words text-v2-text-text-base">
                      {option.label}
                    </span>
                    <Show when={option.description}>
                      <span class="mt-0.5 block text-[12px] leading-snug text-v2-text-text-muted">
                        {option.description}
                      </span>
                    </Show>
                  </span>
                </button>
              )}
            </For>

            <Show
              when={store.editing}
              fallback={
                <button
                  type="button"
                  class={`relative flex w-full cursor-pointer items-start gap-2.5 rounded-[8px] border bg-v2-background-bg-base px-3 py-2.5 text-left transition-all duration-200 ${on() ? PICKED : `${UNPICKED} shadow-sm`}`}
                  disabled={sending()}
                  onClick={customOpen}
                >
                  <Mark checked={on()} />
                  <span class="min-w-0 flex-1">
                    <span class="block text-[14px] leading-snug font-[500] break-words text-v2-text-text-base">
                      {language.t("ui.messagePart.option.typeOwnAnswer")}
                    </span>
                    <span class="mt-0.5 block text-[12px] leading-snug text-v2-text-text-muted">
                      {input() || language.t("ui.question.custom.placeholder")}
                    </span>
                  </span>
                </button>
              }
            >
              <form
                class={`relative flex w-full items-start gap-2.5 rounded-[8px] border bg-v2-background-bg-base px-3 py-2.5 text-left transition-all duration-200 ${on() ? PICKED : "border-v2-border-border-base"}`}
                onSubmit={(event) => {
                  event.preventDefault()
                  commitCustom()
                }}
              >
                <button
                  type="button"
                  class="cursor-pointer border-0 bg-transparent p-0"
                  disabled={sending()}
                  onClick={customToggle}
                >
                  <Mark checked={on()} />
                </button>
                <span class="min-w-0 flex-1">
                  <span class="block text-[14px] leading-snug font-[500] break-words text-v2-text-text-base">
                    {language.t("ui.messagePart.option.typeOwnAnswer")}
                  </span>
                  <textarea
                    ref={(element) =>
                      setTimeout(() => {
                        element.focus()
                        resize(element)
                      }, 0)
                    }
                    data-slot="question-custom-input"
                    placeholder={language.t("ui.question.custom.placeholder")}
                    value={input()}
                    rows={1}
                    disabled={sending()}
                    class="mt-0.5 w-full resize-none border-0 bg-transparent p-0 text-[12px] text-v2-text-text-base outline-none placeholder:text-v2-text-text-faint"
                    onKeyDown={(event) => {
                      if (event.key === "Escape") {
                        event.preventDefault()
                        setStore("editing", false)

                        return
                      }

                      if ((event.metaKey || event.ctrlKey) && !event.altKey) return

                      if (event.key !== "Enter" || event.shiftKey) return
                      event.preventDefault()
                      commitCustom()
                    }}
                    onInput={(event) => {
                      customUpdate(event.currentTarget.value)
                      resize(event.currentTarget)
                    }}
                  />
                </span>
              </form>
            </Show>
          </div>
        </div>
      </div>
      <div class="shrink-0 border-t border-v2-border-border-base bg-v2-background-bg-base">
        <div class="mx-auto flex w-full max-w-lg items-center justify-between gap-3 px-5 py-1.5">
          <button
            type="button"
            class="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-[6px] px-3 text-[13px] font-[500] text-v2-text-text-muted transition-all duration-150 hover:bg-v2-overlay-simple-overlay-hover hover:text-v2-text-text-base disabled:cursor-not-allowed disabled:opacity-35"
            disabled={sending()}
            onClick={() => rejectMutation.mutate()}
          >
            <svg viewBox="0 0 14 14" fill="none" class="size-3.5">
              <path d="M4 4L10 10M10 4L4 10" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
            </svg>
            {language.t("ui.common.dismiss")}
          </button>
          <div class="flex items-center gap-2">
            <Show when={store.tab > 0}>
              <button
                type="button"
                class="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-[8px] border border-v2-border-border-base bg-v2-background-bg-base px-3 text-[13px] font-[500] text-v2-text-text-base shadow-[var(--v2-elevation-button-neutral)] transition-all duration-150 hover:bg-v2-overlay-simple-overlay-hover disabled:cursor-not-allowed disabled:opacity-35"
                disabled={sending()}
                onClick={() => {
                  setStore("tab", store.tab - 1)
                  setStore("editing", false)
                }}
              >
                <svg viewBox="0 0 14 14" fill="none" class="size-3.5 text-v2-text-text-muted">
                  <path d="M9 3L5 7L9 11" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
                </svg>
                {language.t("ui.common.back")}
              </button>
            </Show>
            <button
              type="button"
              class="inline-flex h-8 cursor-pointer items-center justify-center gap-2 rounded-[6px] px-3.5 text-[12px] font-[500] tracking-wide transition-all duration-150 ease-in-out select-none hover:opacity-90 active:scale-[0.98] disabled:cursor-not-allowed"
              style={
                sending() || !primaryEnabled()
                  ? { background: "var(--v2-background-bg-layer-03)", color: "var(--v2-text-text-faint)" }
                  : { background: GRADIENT, color: "#fff" }
              }
              disabled={sending() || !primaryEnabled()}
              onClick={next}
            >
              <span>{last() ? language.t("ui.common.submit") : language.t("ui.common.next")}</span>
              <svg viewBox="0 0 14 14" fill="none" class="size-3.5">
                <path d="M5 3L9 7L5 11" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" />
              </svg>
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function Mark(props: { checked: boolean }) {
  return (
    <span
      class="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border transition-all duration-200"
      classList={{
        "border-[#1a64d6] bg-[#1a64d6]": props.checked,
        "border-v2-border-border-base": !props.checked,
      }}
    >
      <Show when={props.checked}>
        <svg viewBox="0 0 12 12" fill="none" class="size-2.5 text-[#fff]">
          <path
            d="M2.5 6.5L4.5 8.5L9.5 3.5"
            stroke="currentColor"
            stroke-width="2.8"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
      </Show>
    </span>
  )
}
