// The changed files, staged and not, with the change of the file on screen below the list.

import { For, Show } from "solid-js"
import { usePlugin } from "@opencode/plugin/gui"
import type { GitTool } from "@opencode/schema/git-tool"
import { Icon } from "@opencode/ui/icon"
import { Tooltip } from "@opencode/ui/tooltip"
import { FileDiff } from "./diff"
import { card, Counts, FilePath, iconButton, kicker, quiet } from "../ui"
import { checkbox, StateChip } from "./ui"
import type { GitView } from "./view"

export function Changes(props: { view: GitView; onResult: (message?: string) => void }) {
  const ctx = usePlugin()
  const view = props.view
  const total = () => view.status().files.length

  const opened = () => {
    const selected = view.selected()

    if (!selected || !("path" in selected)) return undefined
    const file = view.status().files.find((item) => item.path === selected.path)

    return file ? { file, staged: selected.staged } : undefined
  }

  const discard = async (files: readonly GitTool.FileChange[]) => {
    const confirmed = await ctx.dialogs.confirm({
      title:
        files.length === 1
          ? ctx.t("git.discard.titleFile", { file: files[0]?.path ?? "" })
          : ctx.plural("git.discard.title", files.length),
      description: [
        ...(files.length > 1
          ? [
              files
                .slice(0, 5)
                .map((file) => file.path)
                .join(", ") + (files.length > 5 ? ` ${ctx.t("git.discard.more", { count: files.length - 5 })}` : ""),
            ]
          : []),
        ctx.t("git.discard.description"),
      ].join("\n\n"),
      confirm: ctx.t("git.discard.confirm"),
      danger: true,
    })

    if (!confirmed) return

    if (await view.discard(files)) props.onResult(ctx.plural("git.discarded", files.length))
  }

  return (
    <div data-slot="git-changes" class={card}>
      <div class="flex items-baseline justify-between gap-2">
        <span class={kicker}>{ctx.t("git.changes.title")}</span>
        <Show when={total() > 0}>
          <span class="text-12-regular text-v2-text-text-faint">{ctx.plural("git.changes.count", total())}</span>
        </Show>
      </div>

      <Show
        when={view.groups().staged.length + view.groups().changes.length > 0}
        fallback={
          <div class="flex items-center gap-2.5 p-3.5 rounded-lg bg-v2-overlay-simple-overlay-hover/60 text-v2-text-text-muted">
            <Icon name="circle-check" size="small" />
            <span class="text-12-regular">{ctx.t("git.changes.clean")}</span>
          </div>
        }
      >
        <span class="-mt-2 text-12-regular text-v2-text-text-muted">{ctx.t("git.changes.hint")}</span>
        <Group
          view={view}
          title={ctx.t("git.changes.staged")}
          files={view.groups().staged}
          staged
          action={ctx.t("git.changes.unstageAll")}
          onAction={() => view.toggleAll(true)}
        />
        <Group
          view={view}
          title={ctx.t("git.changes.unstaged")}
          files={view.groups().changes}
          staged={false}
          action={ctx.t("git.changes.stageAll")}
          onAction={() => view.toggleAll(false)}
          onDiscard={(files) => void discard(files)}
        />
      </Show>

      <Show when={opened()} keyed>
        {(open) => (
          <div class="flex flex-col gap-2">
            <div class="flex items-center gap-2">
              <span class="flex-1 min-w-0 truncate text-12-medium text-v2-text-text-base">
                {open.staged ? ctx.t("git.diff.staged") : ctx.t("git.diff.unstaged")}
              </span>
              <button type="button" class={quiet} onClick={() => view.close()}>
                <Icon name="close-small" size="small" />
                {ctx.t("git.diff.close")}
              </button>
            </div>
            <FileDiff view={view} file={open.file} staged={open.staged} />
          </div>
        )}
      </Show>
    </div>
  )
}

function Group(props: {
  view: GitView
  title: string
  files: readonly GitTool.FileChange[]
  staged: boolean
  action: string
  onAction: () => void
  onDiscard?: (files: readonly GitTool.FileChange[]) => void
}) {
  const ctx = usePlugin()

  const active = (file: GitTool.FileChange) => {
    const selected = props.view.selected()

    return !!selected && "path" in selected && selected.path === file.path && selected.staged === props.staged
  }

  return (
    <Show when={props.files.length > 0}>
      <div class="flex flex-col">
        <div class="flex items-center gap-2 pb-1.5 border-b border-v2-border-border-base">
          <input
            type="checkbox"
            class={checkbox}
            aria-label={props.action}
            checked={props.staged}
            disabled={!!props.view.busy()}
            onChange={(event) => {
              // The list decides the box: it stays as it was until the status says the files moved.
              event.currentTarget.checked = props.staged
              props.onAction()
            }}
          />
          <span class="text-12-medium text-v2-text-text-base">{props.title}</span>
          <span class="min-w-4 px-1 rounded-full bg-v2-overlay-simple-overlay-hover text-[10px] font-medium text-center text-v2-text-text-muted">
            {props.files.length}
          </span>
          <div class="ms-auto flex items-center gap-0.5">
            <Show when={props.onDiscard}>
              {(discard) => (
                <button
                  type="button"
                  class={quiet}
                  disabled={!!props.view.busy()}
                  onClick={() => discard()(props.files)}
                >
                  {ctx.t("git.discard.all")}
                </button>
              )}
            </Show>
            <button type="button" class={quiet} disabled={!!props.view.busy()} onClick={() => props.onAction()}>
              {props.action}
            </button>
          </div>
        </div>
        <For each={props.files}>
          {(file) => (
            <div
              data-slot="git-file"
              class="group flex items-center gap-2 h-8 px-1.5 -mx-1.5 rounded-md transition-colors hover:bg-v2-overlay-simple-overlay-hover"
              classList={{ "bg-[#1a64d6]/15 shadow-[inset_0_0_0_1px_rgb(26_100_214/0.35)]": active(file) }}
            >
              <input
                type="checkbox"
                class={checkbox}
                aria-label={props.staged ? ctx.t("git.file.unstage") : ctx.t("git.file.stage")}
                checked={props.staged}
                disabled={!!props.view.busy()}
                onChange={(event) => {
                  event.currentTarget.checked = props.staged
                  props.view.stage([file], !props.staged)
                }}
              />
              <button
                type="button"
                class="flex flex-1 min-w-0 items-center gap-2 h-full text-start cursor-pointer"
                aria-pressed={active(file)}
                onClick={() =>
                  active(file) ? props.view.close() : props.view.open({ path: file.path, staged: props.staged })
                }
              >
                <StateChip state={file.state} />
                <FilePath path={file.path} oldPath={file.oldPath} />
              </button>
              <Counts additions={file.additions} deletions={file.deletions} />
              <Show when={props.onDiscard}>
                {(discard) => (
                  <Tooltip value={ctx.t("git.discard")} placement="left">
                    <button
                      type="button"
                      aria-label={ctx.t("git.discard")}
                      class={`${iconButton} opacity-0 group-hover:opacity-100 focus-visible:opacity-100`}
                      disabled={!!props.view.busy()}
                      onClick={() => discard()([file])}
                    >
                      <Icon name="outline-undo" size="small" />
                    </button>
                  </Tooltip>
                )}
              </Show>
            </div>
          )}
        </For>
      </div>
    </Show>
  )
}
