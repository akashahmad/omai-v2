// The Git tool: the project's branch, changes, commits and remotes, for people who never open a terminal.

import { createSignal, For, onMount, Show } from "solid-js"
import { makeEventListener } from "@solid-primitives/event-listener"
import { usePlugin } from "@opencode/plugin/gui"
import { Icon } from "@opencode/ui/icon"
import { Tooltip } from "@opencode/ui/tooltip"
import { Changes } from "./changes"
import { pushRemote } from "./model"
import { Commit } from "./commit"
import { Header } from "./header"
import { History } from "./history"
import { Remotes } from "./remotes"
import { Busy, FilePath, iconButton, primary, quiet, secondary, Spinner } from "../ui"
import { ProblemNote, StateChip } from "./ui"
import type { GitView } from "./view"

export function GitPanel(props: { view: GitView }) {
  const ctx = usePlugin()

  return (
    <div data-component="tools-git" class="@container flex flex-col gap-4 pb-10">
      <div class="flex items-start gap-3">
        <div class="flex flex-1 min-w-0 flex-col gap-1">
          <div class="text-16-medium text-v2-text-text-base">{ctx.t("git.title")}</div>
          <div class="text-[13px] text-v2-text-text-muted">{ctx.t("git.description")}</div>
        </div>
        <Tooltip value={ctx.t("git.refresh")} placement="left">
          <button
            type="button"
            data-action="git-refresh"
            aria-label={ctx.t("git.refresh")}
            class={`${iconButton} size-8`}
            onClick={() => void props.view.refresh()}
          >
            <Icon name="refresh" size="small" />
          </button>
        </Tooltip>
      </div>
      {/* A session switch brings another view; the drafts of the last one stay behind with it. */}
      <Show when={props.view} keyed>
        {(view) => <Body view={view} />}
      </Show>
    </div>
  )
}

function Body(props: { view: GitView }) {
  const ctx = usePlugin()
  const view = props.view
  const status = () => view.status()
  const [adding, setAdding] = createSignal(false)
  let remotes: HTMLDivElement | undefined

  // Git changes outside the app too (a terminal, an editor), so the status is read again whenever the panel shows and
  // whenever the window comes back to the front.
  onMount(() => void view.refresh())
  makeEventListener(window, "focus", () => void view.refresh())

  const result = (message?: string) => {
    if (message) ctx.toast.show({ variant: "success", title: message })
  }

  // Pushes to the upstream's remote, or the only one; with several and no upstream, the user picks.
  const push = async () => {
    const remote =
      pushRemote(status()) ??
      (await ctx.dialogs.select({
        title: ctx.t("git.push.choose"),
        options: status().remotes.map((item) => ({ title: item.name, value: item.name, description: item.url })),
      }))

    if (!remote) return
    result((await view.push(remote))?.message)
  }

  const addRemote = () => {
    setAdding(true)
    remotes?.scrollIntoView({ behavior: "smooth", block: "nearest" })
  }

  return (
    <Show
      when={view.loaded()}
      fallback={
        <Show when={view.error()} fallback={<Loading />}>
          {(problem) => <ProblemNote problem={problem()} onRetry={() => void view.refresh()} />}
        </Show>
      }
    >
      <Show when={view.error()}>
        {(problem) => <ProblemNote problem={problem()} onDismiss={() => view.dismissError()} />}
      </Show>
      <Show when={status().repo} fallback={<NotRepo view={view} onResult={result} />}>
        <Header view={view} onAddRemote={addRemote} onPush={push} onResult={result} />
        <Show when={status().operation}>
          <Conflicts view={view} onResult={result} />
        </Show>
        <Changes view={view} onResult={result} />
        <Commit view={view} onPush={push} onResult={result} />
        <Remotes
          view={view}
          adding={adding()}
          onAdding={setAdding}
          onResult={result}
          ref={(element) => {
            remotes = element
          }}
        />
        <History view={view} />
      </Show>
    </Show>
  )
}

function Loading() {
  return (
    <div class="flex items-center justify-center py-16 text-v2-text-text-muted">
      <Spinner large />
    </div>
  )
}

function NotRepo(props: { view: GitView; onResult: (message?: string) => void }) {
  const ctx = usePlugin()

  return (
    <div
      data-slot="git-not-repo"
      class="flex flex-col items-center gap-4 px-6 py-10 rounded-xl border border-dashed border-v2-border-border-base text-center"
    >
      <span class="flex items-center justify-center size-12 rounded-xl bg-[#0a3a78] text-[#fff]">
        <Icon name="branch" />
      </span>
      <div class="flex flex-col gap-1 max-w-[340px]">
        <b class="text-14-medium text-v2-text-text-base">{ctx.t("git.notRepo.title")}</b>
        <span class="text-12-regular leading-[1.5] text-v2-text-text-muted">{ctx.t("git.notRepo.description")}</span>
      </div>
      <button
        type="button"
        data-action="git-init"
        class={`${primary} h-9 px-4`}
        disabled={!!props.view.busy()}
        onClick={async () => {
          if (await props.view.init()) props.onResult(ctx.t("git.notRepo.created"))
        }}
      >
        <Busy when={props.view.busy() === "init"}>
          <Icon name="plus" size="small" />
        </Busy>
        {ctx.t("git.notRepo.create")}
      </button>
    </div>
  )
}

/** A merge or rebase that stopped: the files it stopped on, and the two ways out. */
function Conflicts(props: { view: GitView; onResult: (message?: string) => void }) {
  const ctx = usePlugin()
  const [asking, setAsking] = createSignal(false)
  const operation = () => props.view.status().operation ?? "merge"
  const files = () => props.view.groups().conflicted

  const ask = async () => {
    setAsking(true)
    const sent = await props.view.askToResolve()
    setAsking(false)

    if (sent) props.onResult(ctx.t("git.conflicts.asked"))
  }

  return (
    <div
      data-slot="git-conflicts"
      class="flex flex-col gap-3 p-4 rounded-xl border border-v2-state-border-warning bg-v2-state-bg-warning"
    >
      <div class="flex items-start gap-2.5">
        <Icon name="warning" class="shrink-0 text-v2-state-fg-warning" />
        <div class="flex flex-col gap-0.5 min-w-0">
          <b class="text-[13px] font-medium text-v2-text-text-base">{ctx.t(`git.conflicts.title.${operation()}`)}</b>
          <span class="text-12-regular leading-[1.5] text-v2-text-text-muted">
            {files().length > 0
              ? ctx.plural("git.conflicts.description", files().length)
              : ctx.t(`git.conflicts.resolved.${operation()}`)}
          </span>
        </div>
      </div>
      <Show when={files().length > 0}>
        <div class="flex flex-col gap-1 px-3 py-2 rounded-lg bg-v2-background-bg-layer-01">
          <For each={files()}>
            {(file) => (
              <div class="flex items-center gap-2 h-6">
                <StateChip state={file.state} />
                <FilePath path={file.path} />
                <button
                  type="button"
                  data-action="git-mark-resolved"
                  class={`${quiet} ms-auto`}
                  disabled={!!props.view.busy()}
                  onClick={() => props.view.stage([file], true)}
                >
                  {ctx.t("git.conflicts.resolve")}
                </button>
              </div>
            )}
          </For>
        </div>
      </Show>
      <div class="flex flex-wrap items-center gap-2">
        <Show when={files().length === 0}>
          <button
            type="button"
            data-action="git-continue"
            class={primary}
            disabled={!!props.view.busy()}
            onClick={async () => props.onResult((await props.view.continue())?.message)}
          >
            <Busy when={props.view.busy() === "continue"}>
              <Icon name="check" size="small" />
            </Busy>
            {ctx.t("git.conflicts.continue")}
          </button>
        </Show>
        <Show when={files().length > 0}>
          <button
            type="button"
            data-action="git-resolve"
            class={primary}
            disabled={asking() || !!props.view.busy()}
            onClick={() => void ask()}
          >
            <Busy when={asking()}>
              <Icon name="outline-brain" size="small" />
            </Busy>
            {ctx.t("git.conflicts.ask")}
          </button>
        </Show>
        <button
          type="button"
          data-action="git-abort"
          class={secondary}
          disabled={!!props.view.busy()}
          onClick={async () => props.onResult((await props.view.abort())?.message)}
        >
          <Busy when={props.view.busy() === "abort"}>
            <Icon name="close-small" size="small" />
          </Busy>
          {ctx.t(`git.conflicts.abort.${operation()}`)}
        </button>
      </div>
    </div>
  )
}
