// The Git panel's own pieces; the ones every tool shares come from the Tools folder.

import { Show } from "solid-js"
import { usePlugin } from "@opencode/plugin/gui"
import { Icon } from "@opencode/ui/icon"
import type { GitTool } from "@opencode/schema/git-tool"
import { iconButton } from "../ui"
import type { Problem } from "./view"

export const field =
  "h-8 w-full min-w-0 px-3 rounded-md border border-v2-border-border-base bg-transparent text-[13px] text-v2-text-text-base outline-none focus:border-v2-border-border-strong placeholder:text-v2-text-text-faint"

export const checkbox = "size-3.5 shrink-0 cursor-pointer accent-[#0a3a78] disabled:cursor-default"

const STATE_CLASS = {
  added: "bg-[#3f8f6a]/12 text-[#3f8f6a]",
  untracked: "bg-[#3f8f6a]/12 text-[#3f8f6a]",
  modified: "bg-[#c99a3c]/15 text-[#a77a22]",
  renamed: "bg-[#5b84c4]/12 text-[#4a72b0]",
  deleted: "bg-[#c4483e]/12 text-[#c4483e]",
  conflicted: "bg-[#c4483e]/12 text-[#c4483e]",
} satisfies Record<GitTool.FileChange["state"], string>

const STATE_LETTER = {
  added: "A",
  untracked: "U",
  modified: "M",
  renamed: "R",
  deleted: "D",
  conflicted: "!",
} satisfies Record<GitTool.FileChange["state"], string>

/** The one-letter chip of a file's state, with the state spelled out for hover and assistive technology. */
export function StateChip(props: { state: GitTool.FileChange["state"] }) {
  const ctx = usePlugin()

  return (
    <span
      title={ctx.t(`git.state.${props.state}`)}
      aria-label={ctx.t(`git.state.${props.state}`)}
      class={`shrink-0 inline-flex items-center justify-center size-[18px] rounded-md text-[10px] font-[600] font-mono ${STATE_CLASS[props.state]}`}
    >
      {STATE_LETTER[props.state]}
    </span>
  )
}

/** What failed, in plain words, with Git's own output folded away under "Details". */
export function ProblemNote(props: { problem: Problem; onDismiss?: () => void; onRetry?: () => void }) {
  const ctx = usePlugin()

  return (
    <div
      data-slot="git-error"
      class="flex items-start gap-2 px-3 py-2.5 rounded-lg bg-v2-state-bg-danger text-v2-state-fg-danger text-12-regular"
    >
      <Icon name="warning" size="small" class="shrink-0 mt-px" />
      <div class="flex flex-1 min-w-0 flex-col gap-1.5">
        <span class="break-words font-medium">{props.problem.message}</span>
        <Show when={props.problem.details.trim()}>
          <details class="group">
            <summary class="inline-flex items-center gap-1 cursor-pointer select-none list-none opacity-80 hover:opacity-100">
              <Icon
                name="fill-triangle-down"
                size="small"
                class="-rotate-90 transition-transform group-open:rotate-0"
              />
              {ctx.t("git.error.details")}
            </summary>
            <pre class="mt-1.5 max-h-48 overflow-auto p-2 rounded-md bg-v2-background-bg-base/60 font-mono text-[11px] leading-[1.5] whitespace-pre-wrap break-words text-v2-text-text-muted">
              {props.problem.details.trim()}
            </pre>
          </details>
        </Show>
      </div>
      <Show when={props.onRetry}>
        {(retry) => (
          <button
            type="button"
            data-action="git-retry"
            class="shrink-0 inline-flex items-center gap-1 h-6 px-2 rounded-md text-12-medium cursor-pointer transition-colors hover:bg-v2-overlay-simple-overlay-hover"
            onClick={() => retry()()}
          >
            <Icon name="refresh" size="small" />
            {ctx.t("git.error.retry")}
          </button>
        )}
      </Show>
      <Show when={props.onDismiss}>
        {(dismiss) => (
          <button type="button" aria-label={ctx.t("git.error.dismiss")} class={iconButton} onClick={() => dismiss()()}>
            <Icon name="close-small" size="small" />
          </button>
        )}
      </Show>
    </div>
  )
}
