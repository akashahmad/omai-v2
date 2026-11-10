import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import type { SessionMessageInfo } from "@opencode/client/promise"
import { useLanguage } from "@/runtime/i18n/language"

/** One prompt in a shared conversation and the start of the reply it got. */
export type RailTurn = { id: string; prompt: string; reply: string }

/** The conversation's prompts in order, each with the text the agent answered before the next prompt. */
export function railTurns(messages: SessionMessageInfo[]): RailTurn[] {
  const turns: RailTurn[] = []

  messages.forEach((message) => {
    if (message.type === "user") return void turns.push({ id: message.id, prompt: plain(message.text), reply: "" })

    const last = turns.at(-1)

    if (message.type !== "assistant" || !last) return
    const text = plain(message.content.flatMap((content) => (content.type === "text" ? [content.text] : [])).join(" "))

    if (text) last.reply = last.reply ? `${last.reply} ${text}` : text
  })

  return turns
}

// Markdown markers and line breaks read as noise in a one-line preview.
const plain = (text: string) =>
  text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[`*_#>]+/g, "")
    .replace(/\s+/g, " ")
    .trim()

/**
 * The share page's message rail: a tick per prompt down the left edge, the one in view drawn longer. Hovering a tick
 * shows its prompt and the start of its reply; clicking scrolls to it. `scroller` is the page's scroll container.
 */
export function MessageRail(props: { messages: SessionMessageInfo[]; scroller: HTMLElement }) {
  const language = useLanguage()
  const turns = createMemo(() => railTurns(props.messages))
  const [current, setCurrent] = createSignal<string>()
  const [hovered, setHovered] = createSignal<{ turn: RailTurn; top: number; left: number }>()

  const anchor = (id: string) =>
    props.scroller.querySelector<HTMLElement>(`[data-timeline-row="UserMessage"][data-message-id="${CSS.escape(id)}"]`)

  // The prompt in view is the last one whose top has passed the upper third of the page.
  const track = () => {
    const line = props.scroller.getBoundingClientRect().top + props.scroller.clientHeight / 3
    const passed = turns().filter((turn) => (anchor(turn.id)?.getBoundingClientRect().top ?? Infinity) <= line)

    setCurrent((passed.at(-1) ?? turns()[0])?.id)
  }

  onMount(() => {
    track()
    props.scroller.addEventListener("scroll", track, { passive: true })
    onCleanup(() => props.scroller.removeEventListener("scroll", track))
  })

  const go = (turn: RailTurn) => {
    setHovered(undefined)
    anchor(turn.id)?.scrollIntoView({ block: "start", behavior: "smooth" })
  }

  const show = (turn: RailTurn, element: HTMLElement) => {
    const rect = element.getBoundingClientRect()

    setHovered({ turn, top: rect.top + rect.height / 2, left: rect.right + 16 })
  }

  return (
    <Show when={turns().length > 1}>
      <nav
        aria-label={language.t("share.page.nav")}
        class="fixed top-1/2 left-3 z-30 hidden max-h-[70vh] -translate-y-1/2 flex-col overflow-y-auto py-2 [scrollbar-width:none] md:flex"
        onMouseLeave={() => setHovered(undefined)}
        onScroll={() => setHovered(undefined)}
      >
        <For each={turns()}>
          {(turn) => (
            <button
              type="button"
              aria-label={turn.prompt || language.t("share.page.untitledMessage")}
              aria-current={turn.id === current() ? "true" : undefined}
              class="group flex h-[12px] w-[40px] shrink-0 cursor-pointer items-center outline-none"
              onClick={() => go(turn)}
              onMouseEnter={(event) => show(turn, event.currentTarget)}
              onFocus={(event) => show(turn, event.currentTarget)}
              onBlur={() => setHovered(undefined)}
            >
              <span
                classList={{
                  "block h-[2px] rounded-full transition-[width,background-color] duration-200": true,
                  "w-[32px] bg-v2-text-text-muted": turn.id === current(),
                  "w-[16px] bg-v2-border-border-base group-hover:w-[32px] group-hover:bg-v2-text-text-muted group-focus-visible:w-[32px] group-focus-visible:bg-v2-text-text-muted":
                    turn.id !== current(),
                }}
              />
            </button>
          )}
        </For>
      </nav>
      <Show when={hovered()}>
        {(card) => (
          <div
            aria-hidden="true"
            class="pointer-events-none fixed z-40 hidden w-[320px] -translate-y-1/2 flex-col gap-1.5 rounded-[14px] border border-v2-border-border-base bg-v2-background-bg-base px-4 py-3 shadow-[0_12px_32px_rgba(0,0,0,0.12)] md:flex"
            style={{
              top: `${Math.min(Math.max(card().top, 90), window.innerHeight - 90)}px`,
              left: `${card().left}px`,
            }}
          >
            <span class="truncate text-[14px] font-[500] text-v2-text-text-base">
              {card().turn.prompt || language.t("share.page.untitledMessage")}
            </span>
            <Show when={card().turn.reply}>
              <span class="line-clamp-3 text-[13px] leading-[20px] text-v2-text-text-muted">{card().turn.reply}</span>
            </Show>
          </div>
        )}
      </Show>
    </Show>
  )
}
