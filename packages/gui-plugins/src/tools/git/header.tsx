// The Git panel's top card: the branch, how it stands against the remote, the sync actions and who commits.

import { createSignal, For, Show } from "solid-js"
import { usePlugin } from "@opencode/plugin/gui"
import { Icon } from "@opencode/ui/icon"
import { Menu } from "@opencode/ui/menu"
import { Tooltip } from "@opencode/ui/tooltip"
import { pushRemote } from "./model"
import { ProfileForm } from "./profile"
import { Busy, card, primary, quiet, secondary } from "../ui"
import type { GitView } from "./view"

export function Header(props: {
  view: GitView
  onAddRemote: () => void
  onPush: () => Promise<void>
  onResult: (message?: string) => void
}) {
  const ctx = usePlugin()
  const view = props.view
  const status = () => view.status()
  const remote = () => status().remotes.length > 0
  const diverged = () => status().ahead > 0 && status().behind > 0
  const [editing, setEditing] = createSignal(false)

  const newBranch = async () => {
    const name = await ctx.dialogs.prompt({
      title: ctx.t("git.branch.new.title"),
      description: ctx.t("git.branch.new.description"),
      placeholder: ctx.t("git.branch.new.placeholder"),
      submit: ctx.t("git.branch.new.submit"),
    })

    if (!name?.trim()) return

    if (await view.branchCreate(name.trim())) props.onResult(ctx.t("git.branch.created", { branch: name.trim() }))
  }

  const switchTo = async (name: string) => {
    if (await view.branchSwitch(name)) props.onResult(ctx.t("git.branch.switched", { branch: name }))
  }

  const pull = async (mode?: "rebase" | "merge") => props.onResult((await view.pull(mode))?.message)

  return (
    <div class={`${card} @container gap-3.5`}>
      <div class="flex flex-wrap items-center gap-x-3 gap-y-2.5">
        <div class="flex min-w-0 flex-1 items-center gap-2.5">
          <Menu gutter={4} placement="bottom-start" modal={false}>
            <Menu.Trigger
              as="button"
              type="button"
              data-action="git-branch"
              disabled={!!view.busy()}
              aria-label={ctx.t("git.branch.label")}
              class="flex min-w-0 items-center gap-1.5 h-8 px-2.5 rounded-lg border border-v2-border-border-base text-[13px] font-medium text-v2-text-text-base cursor-pointer transition-colors hover:bg-v2-overlay-simple-overlay-hover disabled:opacity-50 disabled:cursor-default"
            >
              <Icon name="branch" size="small" class="shrink-0 text-v2-text-text-muted" />
              <span class="truncate max-w-[180px]">
                {status().detached ? ctx.t("git.branch.detached") : (status().branch ?? ctx.t("git.branch.none"))}
              </span>
              <Busy when={view.busy() === "branch"}>
                <Icon name="chevron-down" size="small" class="shrink-0 text-v2-text-text-faint" />
              </Busy>
            </Menu.Trigger>
            <Menu.Portal>
              <Menu.Content class="w-64 max-h-80 overflow-y-auto">
                <Menu.Group>
                  <Menu.GroupLabel>{ctx.t("git.branch.switch")}</Menu.GroupLabel>
                  <For each={status().branches}>
                    {(branch) => (
                      <Menu.Item onSelect={() => !branch.current && void switchTo(branch.name)}>
                        <span class="flex-1 truncate">{branch.name}</span>
                        <Show when={branch.current}>
                          <Icon name="check" size="small" />
                        </Show>
                      </Menu.Item>
                    )}
                  </For>
                </Menu.Group>
                <Menu.Separator />
                <Menu.Item onSelect={() => void newBranch()}>
                  <Icon name="plus" size="small" />
                  <span>{ctx.t("git.branch.new")}</span>
                </Menu.Item>
              </Menu.Content>
            </Menu.Portal>
          </Menu>
          <span class="min-w-0 truncate text-12-regular text-v2-text-text-muted">{view.summary()}</span>
        </div>

        <div class="flex items-center gap-1.5 @max-[30rem]:w-full">
          <Tooltip value={ctx.t("git.noRemote.tooltip")} inactive={remote()} placement="bottom">
            <button
              type="button"
              data-action="git-fetch"
              class={secondary}
              disabled={!remote() || !!view.busy()}
              onClick={async () => props.onResult((await view.fetch())?.message)}
            >
              <Busy when={view.busy() === "fetch"}>
                <Icon name="download" size="small" />
              </Busy>
              {ctx.t("git.fetch")}
            </button>
          </Tooltip>
          <Tooltip value={ctx.t("git.noRemote.tooltip")} inactive={remote()} placement="bottom">
            <Show
              when={diverged()}
              fallback={
                <button
                  type="button"
                  data-action="git-pull"
                  class={status().behind > 0 ? primary : secondary}
                  disabled={!remote() || !!view.busy()}
                  onClick={() => void pull()}
                >
                  <Busy when={view.busy() === "pull"}>
                    <Icon name="arrow-down-to-line" size="small" />
                  </Busy>
                  {ctx.t("git.pull")}
                </button>
              }
            >
              <Menu gutter={4} placement="bottom-end" modal={false}>
                <Menu.Trigger as="button" type="button" data-action="git-pull" class={primary} disabled={!!view.busy()}>
                  <Busy when={view.busy() === "pull"}>
                    <Icon name="arrow-down-to-line" size="small" />
                  </Busy>
                  {ctx.t("git.pull")}
                  <Icon name="chevron-down" size="small" />
                </Menu.Trigger>
                <Menu.Portal>
                  <Menu.Content class="w-72">
                    <Menu.Group>
                      <Menu.GroupLabel>{ctx.t("git.pull.diverged")}</Menu.GroupLabel>
                      <Menu.Item onSelect={() => void pull("rebase")}>
                        <span class="flex flex-col gap-0.5 min-w-0">
                          <span>{ctx.t("git.pull.rebase")}</span>
                          <span class="text-[11px] text-v2-text-text-muted whitespace-normal">
                            {ctx.t("git.pull.rebase.description")}
                          </span>
                        </span>
                      </Menu.Item>
                      <Menu.Item onSelect={() => void pull("merge")}>
                        <span class="flex flex-col gap-0.5 min-w-0">
                          <span>{ctx.t("git.pull.merge")}</span>
                          <span class="text-[11px] text-v2-text-text-muted whitespace-normal">
                            {ctx.t("git.pull.merge.description")}
                          </span>
                        </span>
                      </Menu.Item>
                    </Menu.Group>
                  </Menu.Content>
                </Menu.Portal>
              </Menu>
            </Show>
          </Tooltip>
          <Tooltip value={ctx.t("git.noRemote.tooltip")} inactive={remote()} placement="bottom">
            <button
              type="button"
              data-action="git-push"
              class={status().ahead > 0 && !diverged() ? primary : secondary}
              disabled={!remote() || !!view.busy() || status().detached}
              onClick={() => void props.onPush()}
            >
              <Busy when={view.busy() === "push"}>
                <Icon name="arrow-up" size="small" />
              </Busy>
              {pushRemote(status()) || !remote() ? ctx.t("git.push") : ctx.t("git.push.pick")}
              <Show when={status().ahead > 0}>
                <span
                  class="min-w-4 px-1 rounded-full text-[10px] font-[600] tabular-nums text-center"
                  classList={{
                    "bg-[#fff]/20": !diverged(),
                    "bg-v2-overlay-simple-overlay-hover": diverged(),
                  }}
                >
                  {status().ahead}
                </span>
              </Show>
            </button>
          </Tooltip>
        </div>
      </div>

      <Show when={!remote()}>
        <div class="flex flex-wrap items-center gap-x-2 gap-y-1 text-12-regular text-v2-text-text-muted">
          <Icon name="info" size="small" class="shrink-0" />
          <span>{ctx.t("git.noRemote.description")}</span>
          <button
            type="button"
            data-action="git-add-remote-link"
            class="font-medium text-[#1a64d6] cursor-pointer hover:underline"
            onClick={() => props.onAddRemote()}
          >
            {ctx.t("git.remote.add")}
          </button>
        </div>
      </Show>

      <Show when={status().profile.name && status().profile.email}>
        <div class="flex flex-col gap-3 pt-3 border-t border-v2-border-border-base/70">
          <Show
            when={editing()}
            fallback={
              <div class="flex min-w-0 items-center gap-2 text-12-regular text-v2-text-text-muted">
                <span class="shrink-0 flex items-center justify-center size-6 rounded-full bg-[#0a3a78] text-[#fff] text-[11px] font-[600] uppercase">
                  {(status().profile.name ?? "?").slice(0, 1)}
                </span>
                <span class="min-w-0 truncate">
                  {ctx.t("git.profile.as")}{" "}
                  <span class="font-medium text-v2-text-text-base">{status().profile.name}</span>{" "}
                  <span class="text-v2-text-text-faint">&lt;{status().profile.email}&gt;</span>
                </span>
                <span class="shrink-0 px-1.5 py-0.5 rounded-full bg-v2-overlay-simple-overlay-hover text-[10px] font-medium">
                  {status().profile.scope === "global"
                    ? ctx.t("git.profile.scope.global")
                    : ctx.t("git.profile.scope.local")}
                </span>
                <button
                  type="button"
                  data-action="git-profile-edit"
                  class={`${quiet} ms-auto`}
                  disabled={!!view.busy()}
                  onClick={() => setEditing(true)}
                >
                  <Icon name="edit" size="small" />
                  {ctx.t("git.profile.edit")}
                </button>
              </div>
            }
          >
            <ProfileForm view={view} onDone={() => setEditing(false)} onResult={props.onResult} />
          </Show>
        </div>
      </Show>
    </div>
  )
}
