// The pieces the Tools panels share, in the website audit's card style.

import { Show, type JSX } from "solid-js"
import { usePlugin } from "@opencode/plugin/gui"
import { Icon } from "@opencode/ui/icon"
import { Loader } from "@opencode/ui/loader"
import type { Publish } from "@opencode/schema/publish"

export const card =
  "flex flex-col gap-4 p-5 rounded-xl border border-v2-border-border-base/70 bg-v2-background-bg-layer-01 shadow-[0_1px_2px_rgb(0_0_0/0.04)]"

// The brand's navy, the logo's background.
export const primary =
  "inline-flex items-center justify-center gap-2 h-8 px-3.5 rounded-lg bg-[#0a3a78] text-[#fff] text-[13px] font-medium cursor-pointer transition-colors hover:bg-[#082f62] disabled:opacity-50 disabled:cursor-default disabled:pointer-events-none"

export const secondary =
  "inline-flex items-center justify-center gap-2 h-8 px-3 rounded-lg border border-v2-border-border-base bg-v2-background-bg-base text-[13px] font-medium text-v2-text-text-base cursor-pointer transition-colors hover:bg-v2-overlay-simple-overlay-hover disabled:opacity-50 disabled:cursor-default disabled:pointer-events-none"

export const quiet =
  "inline-flex items-center gap-1 h-6 px-1.5 rounded-md text-12-medium text-v2-text-text-muted cursor-pointer transition-colors hover:bg-v2-overlay-simple-overlay-hover hover:text-v2-text-text-base disabled:opacity-50 disabled:cursor-default"

export const iconButton =
  "shrink-0 flex items-center justify-center size-6 rounded-md cursor-pointer text-v2-text-text-faint transition-colors hover:bg-v2-overlay-simple-overlay-hover hover:text-v2-text-text-base disabled:opacity-50 disabled:cursor-default"

export const kicker = "text-12-medium uppercase tracking-[0.08em] text-v2-text-text-muted"

/** A path with its folder dimmed after the file name, so the name reads first in a narrow panel. */
export function FilePath(props: { path: string; oldPath?: string }) {
  const name = () => props.path.split("/").at(-1) ?? props.path
  const folder = () => props.path.split("/").slice(0, -1).join("/")

  return (
    <span
      class="flex min-w-0 items-baseline gap-1.5"
      title={props.oldPath ? `${props.oldPath} → ${props.path}` : props.path}
    >
      <span class="truncate text-[13px] text-v2-text-text-base">{name()}</span>
      <Show when={folder()}>
        <span class="truncate text-[11px] text-v2-text-text-faint">{folder()}</span>
      </Show>
    </span>
  )
}

export function Counts(props: { additions: number; deletions: number }) {
  return (
    <span class="shrink-0 flex items-center gap-1.5 font-mono text-[11px] tabular-nums">
      <Show when={props.additions > 0}>
        <span class="text-[#3f8f6a]">+{props.additions}</span>
      </Show>
      <Show when={props.deletions > 0}>
        <span class="text-[#c4483e]">−{props.deletions}</span>
      </Show>
    </span>
  )
}

export function Note(props: { tone: "danger" | "warning" | "info"; icon: "warning" | "info"; children: JSX.Element }) {
  return (
    <div
      class="flex items-start gap-2 px-3 py-2.5 rounded-lg text-12-regular"
      classList={{
        "bg-v2-state-bg-danger text-v2-state-fg-danger": props.tone === "danger",
        "bg-v2-state-bg-warning text-v2-state-fg-warning": props.tone === "warning",
        "bg-v2-overlay-simple-overlay-hover text-v2-text-text-muted": props.tone === "info",
      }}
    >
      <Icon name={props.icon} size="small" class="shrink-0 mt-px" />
      <div class="flex-1 min-w-0 break-words">{props.children}</div>
    </div>
  )
}

export function Spinner(props: { large?: boolean }) {
  const size = () => (props.large ? 28 : 14)

  // A small one sits in a button and takes the button's text colour.
  return <Loader width={size()} height={size()} style={props.large ? undefined : { color: "inherit" }} />
}

/** A button's icon, or a spinner while its action runs. */
export function Busy(props: { when: boolean; children: JSX.Element }) {
  return (
    <Show when={props.when} fallback={props.children}>
      <Spinner />
    </Show>
  )
}

/** A refused publishing or domains call: what kind of refusal it was in plain words, then the server's own sentence. */
export function Failure(props: { problem: { kind: Publish.FailureKind; message: string } }) {
  const ctx = usePlugin()
  const title = () => ctx.t(`publish.failed.${props.problem.kind}`)

  return (
    <Note tone="danger" icon="warning">
      <span class="flex flex-col gap-0.5">
        <span class="font-medium">{title()}</span>
        <Show when={props.problem.message && props.problem.message !== title()}>
          <span>{props.problem.message}</span>
        </Show>
      </span>
    </Note>
  )
}
