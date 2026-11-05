// Where the project pushes to and pulls from: add, change or remove a remote.

import { createSignal, For, Show } from "solid-js"
import { usePlugin } from "@opencode/plugin/gui"
import type { GitTool } from "@opencode/schema/git-tool"
import { Icon } from "@opencode/ui/icon"
import { Tooltip } from "@opencode/ui/tooltip"
import { Busy, card, iconButton, kicker, primary, quiet, secondary } from "../ui"
import { field } from "./ui"
import type { GitView } from "./view"

export function Remotes(props: {
  view: GitView
  adding: boolean
  onAdding: (adding: boolean) => void
  onResult: (message?: string) => void
  ref?: (element: HTMLDivElement) => void
}) {
  const ctx = usePlugin()
  const view = props.view
  const [editing, setEditing] = createSignal<string>()

  const remove = async (remote: GitTool.Remote) => {
    const confirmed = await ctx.dialogs.confirm({
      title: ctx.t("git.remote.remove.title", { name: remote.name }),
      description: ctx.t("git.remote.remove.description"),
      confirm: ctx.t("git.remote.remove.confirm"),
      danger: true,
    })

    if (!confirmed) return

    if (await view.remoteRemove(remote.name)) props.onResult(ctx.t("git.remote.removed", { name: remote.name }))
  }

  return (
    <div data-slot="git-remotes" ref={props.ref} class={card}>
      <div class="flex items-center justify-between gap-2">
        <span class={kicker}>{ctx.t("git.remote.title")}</span>
        <Show when={!props.adding}>
          <button
            type="button"
            data-action="git-remote-add"
            class={quiet}
            disabled={!!view.busy()}
            onClick={() => props.onAdding(true)}
          >
            <Icon name="plus" size="small" />
            {ctx.t("git.remote.add")}
          </button>
        </Show>
      </div>

      <Show when={view.status().remotes.length === 0 && !props.adding}>
        <span class="text-12-regular leading-[1.5] text-v2-text-text-muted">{ctx.t("git.remote.empty")}</span>
      </Show>

      <Show when={view.status().remotes.length > 0}>
        <div class="flex flex-col rounded-lg border border-v2-border-border-base overflow-hidden">
          <For each={view.status().remotes}>
            {(remote) => (
              <Show
                when={editing() === remote.name}
                fallback={
                  <div class="group flex items-center gap-2.5 px-3 py-2 border-t border-v2-border-border-base first:border-t-0">
                    <Icon name="server" size="small" class="shrink-0 text-v2-text-text-muted" />
                    <div class="flex flex-1 min-w-0 flex-col">
                      <span class="flex items-center gap-1.5 text-12-medium text-v2-text-text-base">
                        {remote.name}
                        <Show when={remote.push}>
                          <span class="px-1.5 py-px rounded-full bg-[#1a64d6]/15 text-[#1a64d6] text-[10px] font-medium">
                            {ctx.t("git.remote.default")}
                          </span>
                        </Show>
                      </span>
                      <span class="truncate font-mono text-[11px] text-v2-text-text-faint" title={remote.url}>
                        {remote.url}
                      </span>
                    </div>
                    <div class="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100">
                      <Tooltip value={ctx.t("git.remote.edit")} placement="top">
                        <button
                          type="button"
                          aria-label={ctx.t("git.remote.edit")}
                          class={iconButton}
                          disabled={!!view.busy()}
                          onClick={() => setEditing(remote.name)}
                        >
                          <Icon name="edit" size="small" />
                        </button>
                      </Tooltip>
                      <Tooltip value={ctx.t("git.remote.remove")} placement="top">
                        <button
                          type="button"
                          aria-label={ctx.t("git.remote.remove")}
                          class={iconButton}
                          disabled={!!view.busy()}
                          onClick={() => void remove(remote)}
                        >
                          <Icon name="trash" size="small" />
                        </button>
                      </Tooltip>
                    </div>
                  </div>
                }
              >
                <div class="px-3 py-2.5 border-t border-v2-border-border-base first:border-t-0">
                  <RemoteForm
                    view={view}
                    name={remote.name}
                    url={remote.url}
                    onDone={() => setEditing(undefined)}
                    onResult={props.onResult}
                  />
                </div>
              </Show>
            )}
          </For>
        </div>
      </Show>

      <Show when={props.adding}>
        <RemoteForm view={view} onDone={() => props.onAdding(false)} onResult={props.onResult} />
      </Show>
    </div>
  )
}

/** Adds a remote, or, given its name, changes its address. */
function RemoteForm(props: {
  view: GitView
  name?: string
  url?: string
  onDone: () => void
  onResult: (message?: string) => void
}) {
  const ctx = usePlugin()
  const editing = !!props.name
  const [name, setName] = createSignal(props.name ?? (props.view.status().remotes.length === 0 ? "origin" : ""))
  // A masked address would save the mask, so editing starts empty when the address hides credentials.
  const [url, setURL] = createSignal(props.url?.includes("***") ? "" : (props.url ?? ""))
  const valid = () => /^[\w.-]+$/.test(name().trim()) && url().trim().length > 0

  const save = async () => {
    if (!valid() || props.view.busy()) return

    const saved = editing
      ? await props.view.remoteSet(name().trim(), url().trim())
      : await props.view.remoteAdd(name().trim(), url().trim())

    if (!saved) return
    props.onResult(ctx.t(editing ? "git.remote.updated" : "git.remote.added", { name: name().trim() }))
    props.onDone()
  }

  return (
    <form
      data-slot="git-remote-form"
      class="flex flex-col gap-2.5"
      onSubmit={(event) => {
        event.preventDefault()
        void save()
      }}
    >
      <div class="grid grid-cols-[minmax(90px,140px)_1fr] gap-2 @max-[24rem]:grid-cols-1">
        <label class="flex flex-col gap-1 min-w-0">
          <span class="text-12-medium text-v2-text-text-muted">{ctx.t("git.remote.name")}</span>
          <input
            class={field}
            value={name()}
            disabled={editing}
            spellcheck={false}
            placeholder="origin"
            onInput={(event) => setName(event.currentTarget.value)}
          />
        </label>
        <label class="flex flex-col gap-1 min-w-0">
          <span class="text-12-medium text-v2-text-text-muted">{ctx.t("git.remote.url")}</span>
          <input
            class={`${field} font-mono text-12-regular`}
            value={url()}
            spellcheck={false}
            autofocus
            placeholder={ctx.t("git.remote.url.placeholder")}
            onInput={(event) => setURL(event.currentTarget.value)}
          />
        </label>
      </div>
      <div class="flex items-center gap-2">
        <button type="submit" data-action="git-remote-save" class={primary} disabled={!valid() || !!props.view.busy()}>
          <Busy when={props.view.busy() === "remote"}>{null}</Busy>
          {editing ? ctx.t("git.remote.save") : ctx.t("git.remote.add")}
        </button>
        <button type="button" class={secondary} onClick={() => props.onDone()}>
          {ctx.t("git.cancel")}
        </button>
      </div>
    </form>
  )
}
