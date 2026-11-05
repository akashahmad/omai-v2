// The branch's commits, newest first, a page at a time; a commit opens with its files and their changes.

import { createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { usePlugin } from "@opencode/plugin/gui"
import type { GitTool } from "@opencode/schema/git-tool"
import { Icon } from "@opencode/ui/icon"
import { FileDiff } from "./diff"
import { age } from "./model"
import { card, Counts, FilePath, kicker, quiet, Spinner } from "../ui"
import { StateChip } from "./ui"
import type { GitView } from "./view"

export function History(props: { view: GitView }) {
  const ctx = usePlugin()
  const view = props.view

  const opened = () => {
    const selected = view.selected()

    return selected && "hash" in selected ? selected.hash : undefined
  }

  // The clock the relative times read, a minute at a time.
  const [now, setNow] = createSignal(Date.now())
  const timer = setInterval(() => setNow(Date.now()), 60_000)

  onCleanup(() => clearInterval(timer))

  const absolute = (time: number, style: { timeStyle?: "short" } = {}) =>
    new Intl.DateTimeFormat(ctx.locale.locale(), { dateStyle: "medium", ...style }).format(time)

  const relative = (time: number) => {
    const ago = age(time, now())

    if (ago.unit === "now") return ctx.t("git.time.now")

    if (ago.unit === "date") return absolute(time)

    return ctx.plural(`git.time.${ago.unit}`, ago.count)
  }

  onMount(() => {
    if (view.commits().length === 0) view.loadMore()
  })

  return (
    <div data-slot="git-history" class={card}>
      <span class={kicker}>{ctx.t("git.history.title")}</span>
      <Show
        when={view.commits().length > 0}
        fallback={
          <span class="flex items-center gap-2 text-12-regular text-v2-text-text-muted">
            <Show when={view.state.loading} fallback={ctx.t("git.history.empty")}>
              <Spinner />
              {ctx.t("git.history.loading")}
            </Show>
          </span>
        }
      >
        <div class="flex flex-col rounded-lg border border-v2-border-border-base overflow-hidden">
          <For each={view.commits()}>
            {(commit) => (
              <div class="flex flex-col border-t border-v2-border-border-base first:border-t-0">
                <button
                  type="button"
                  data-slot="git-commit-row"
                  aria-expanded={opened() === commit.hash}
                  class="flex items-center gap-2.5 px-3 py-2 text-start cursor-pointer transition-colors hover:bg-v2-overlay-simple-overlay-hover"
                  classList={{
                    "bg-[#1a64d6]/15 shadow-[inset_0_0_0_1px_rgb(26_100_214/0.35)]": opened() === commit.hash,
                  }}
                  onClick={() => (opened() === commit.hash ? view.close() : view.open({ hash: commit.hash }))}
                >
                  <div class="flex flex-1 min-w-0 flex-col gap-0.5">
                    <span class="truncate text-12-medium text-v2-text-text-base">{commit.subject}</span>
                    <span class="truncate text-[11px] text-v2-text-text-faint">
                      {commit.author} ·{" "}
                      <span title={absolute(commit.time, { timeStyle: "short" })}>{relative(commit.time)}</span>
                    </span>
                  </div>
                  <code class="shrink-0 font-mono text-[11px] text-v2-text-text-muted">{commit.short}</code>
                </button>
                <Show when={opened() === commit.hash}>
                  <CommitDetails view={view} commit={commit} />
                </Show>
              </div>
            )}
          </For>
        </div>
        <Show when={view.hasMore()}>
          <button
            type="button"
            class={`${quiet} self-center`}
            disabled={view.state.loading}
            onClick={() => view.loadMore()}
          >
            <Show when={view.state.loading} fallback={<Icon name="chevron-down" size="small" />}>
              <Spinner />
            </Show>
            {ctx.t("git.history.more")}
          </button>
        </Show>
      </Show>
    </div>
  )
}

function CommitDetails(props: { view: GitView; commit: GitTool.Commit }) {
  const ctx = usePlugin()
  const [file, setFile] = createSignal<string>()

  const shown = () => {
    const current = props.view.commitOnScreen()

    return current?.commit.hash === props.commit.hash ? current : undefined
  }

  const selected = () => shown()?.files.find((item) => item.path === file())

  return (
    <div class="flex flex-col gap-2.5 px-3 pb-3 pt-1">
      <Show when={props.commit.body.trim()}>
        <p class="text-12-regular leading-[1.5] whitespace-pre-wrap break-words text-v2-text-text-muted">
          {props.commit.body.trim()}
        </p>
      </Show>
      <Show
        when={shown()}
        fallback={
          <span class="flex items-center gap-2 text-12-regular text-v2-text-text-muted">
            <Spinner />
            {ctx.t("git.history.loadingFiles")}
          </span>
        }
      >
        {(details) => (
          <Show
            when={details().files.length > 0}
            fallback={<span class="text-12-regular text-v2-text-text-muted">{ctx.t("git.history.noFiles")}</span>}
          >
            <div class="flex flex-col">
              <For each={details().files}>
                {(item) => (
                  <button
                    type="button"
                    class="flex items-center gap-2 h-7 px-1.5 -mx-1.5 rounded-md text-start cursor-pointer transition-colors hover:bg-v2-overlay-simple-overlay-hover"
                    classList={{ "bg-v2-overlay-simple-overlay-hover": file() === item.path }}
                    aria-pressed={file() === item.path}
                    onClick={() => setFile(file() === item.path ? undefined : item.path)}
                  >
                    <StateChip state={item.state} />
                    <span class="flex-1 min-w-0">
                      <FilePath path={item.path} oldPath={item.oldPath} />
                    </span>
                    <Counts additions={item.additions} deletions={item.deletions} />
                  </button>
                )}
              </For>
            </div>
          </Show>
        )}
      </Show>
      <Show when={selected()} keyed>
        {(item) => <FileDiff view={props.view} file={item} commit={props.commit.hash} />}
      </Show>
    </div>
  )
}
