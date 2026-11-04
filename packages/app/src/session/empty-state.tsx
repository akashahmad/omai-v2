import { createEffect, createMemo, createSignal, onCleanup, Show } from "solid-js"
import { Icon } from "@opencode/ui/icon"
import { getFilename } from "@opencode/util/path"
import { useLanguage } from "@/runtime/i18n/language"
import { useServer } from "@/runtime/server/current"
import { getRelativeTime } from "@/shell/time"

/** What a session with no conversation yet shows in place of its timeline: where it runs and when it last changed. */
export function SessionEmptyState(props: { directory?: string; updated?: number }) {
  const language = useLanguage()
  const server = useServer()
  const [now, setNow] = createSignal(Date.now())

  const timer = setInterval(() => setNow(Date.now()), 30_000)
  onCleanup(() => clearInterval(timer))

  createEffect(() => {
    const directory = props.directory

    if (directory) void server.ctx.data.location.vcs.sync({ directory }).catch(() => undefined)
  })

  const name = createMemo(() => (props.directory ? getFilename(props.directory) : ""))
  const parent = createMemo(() => (props.directory ?? "").slice(0, -name().length))

  const branch = createMemo(() =>
    props.directory ? server.ctx.data.location.vcs.info({ directory: props.directory })?.branch.current : undefined,
  )

  const modified = createMemo(() => {
    now()

    return props.updated ? getRelativeTime(new Date(props.updated).toISOString(), language.t) : undefined
  })

  return (
    <div
      data-component="session-empty-state"
      class="pointer-events-none absolute inset-0 flex items-center justify-center px-6 pb-40"
    >
      <div class="pointer-events-auto flex max-w-full flex-col items-center gap-4 text-center">
        <h1 class="text-20-medium text-v2-text-text-base">{language.t("session.empty.title")}</h1>
        <Show when={props.directory}>
          <div class="max-w-full truncate text-14-regular text-v2-text-text-muted" dir="ltr">
            {parent()}
            <span class="text-v2-text-text-base">{name()}</span>
          </div>
        </Show>
        <Show when={branch()}>
          {(current) => (
            <div class="flex items-center gap-2 text-14-regular text-v2-text-text-muted">
              <Icon name="branch" size="small" class="shrink-0" />
              <span>{language.t("session.empty.branch", { branch: current() })}</span>
            </div>
          )}
        </Show>
        <Show when={modified()}>
          {(value) => {
            // One translated phrase; only its time is emphasised, wherever the language places it.
            const [before, after] = language.t("session.empty.modified", { time: "\u0000" }).split("\u0000")

            return (
              <div class="text-14-regular text-v2-text-text-muted">
                {before}
                <span class="text-v2-text-text-base">{value()}</span>
                {after}
              </div>
            )
          }}
        </Show>
      </div>
    </div>
  )
}
