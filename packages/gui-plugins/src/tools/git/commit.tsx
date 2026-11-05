// Records the staged files as a commit, and pushes it on request. Before the first commit, it asks who commits.

import { createSignal, Show } from "solid-js"
import { usePlugin } from "@opencode/plugin/gui"
import { Icon } from "@opencode/ui/icon"
import { Tooltip } from "@opencode/ui/tooltip"
import { ProfileForm } from "./profile"
import { Busy, card, kicker, primary, secondary } from "../ui"
import { checkbox, field } from "./ui"
import type { GitView } from "./view"

export function Commit(props: { view: GitView; onPush: () => Promise<void>; onResult: (message?: string) => void }) {
  const ctx = usePlugin()
  const view = props.view
  const status = () => view.status()
  const [summary, setSummary] = createSignal("")
  const [body, setBody] = createSignal("")
  const [amend, setAmend] = createSignal(false)
  const profiled = () => !!status().profile.name && !!status().profile.email
  const staged = () => view.groups().staged.length
  const conflicted = () => view.groups().conflicted.length > 0
  const message = () => [summary().trim(), body().trim()].filter((part) => part.length > 0).join("\n\n")

  // Amending may only reword the last commit, so it needs no staged files.
  const ready = () =>
    summary().trim().length > 0 && profiled() && !conflicted() && (amend() || staged() > 0) && !view.busy()

  const hint = () => {
    if (conflicted()) return ctx.t("git.commit.hint.conflicts")

    if (staged() === 0 && !amend()) return ctx.t("git.commit.hint.nothing")

    return ctx.plural("git.commit.hint.staged", staged())
  }

  const commit = async (push: boolean) => {
    if (!ready()) return
    const done = await view.commit(message(), { amend: amend() })

    if (!done) return
    setSummary("")
    setBody("")
    setAmend(false)
    props.onResult(done.message)

    if (push) await props.onPush()
  }

  const shortcut = (event: KeyboardEvent) => {
    if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey)) return
    event.preventDefault()
    void commit(false)
  }

  return (
    <div data-slot="git-commit" class={card}>
      <span class={kicker}>{ctx.t("git.commit.title")}</span>
      <Show
        when={profiled()}
        fallback={
          <div class="flex flex-col gap-3">
            <div class="flex items-start gap-2.5">
              <span class="shrink-0 flex items-center justify-center size-8 rounded-lg bg-[#0a3a78] text-[#fff]">
                <Icon name="edit" size="small" />
              </span>
              <div class="flex flex-col gap-0.5 min-w-0">
                <b class="text-[13px] font-medium text-v2-text-text-base">{ctx.t("git.profile.setup.title")}</b>
                <span class="text-12-regular leading-[1.5] text-v2-text-text-muted">
                  {ctx.t("git.profile.setup.description")}
                </span>
              </div>
            </div>
            <ProfileForm view={view} onResult={props.onResult} />
          </div>
        }
      >
        <div class="flex flex-col gap-2">
          <input
            data-slot="git-commit-summary"
            class={field}
            value={summary()}
            maxLength={200}
            placeholder={ctx.t("git.commit.summary")}
            aria-label={ctx.t("git.commit.summary")}
            onInput={(event) => setSummary(event.currentTarget.value)}
            onKeyDown={shortcut}
          />
          <textarea
            data-slot="git-commit-body"
            class={`${field} h-auto min-h-16 py-2 leading-[1.5] resize-y`}
            rows={3}
            value={body()}
            placeholder={ctx.t("git.commit.body")}
            aria-label={ctx.t("git.commit.body")}
            onInput={(event) => setBody(event.currentTarget.value)}
            onKeyDown={shortcut}
          />
        </div>
        <div class="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
          <label class="flex items-center gap-2 text-12-regular text-v2-text-text-base cursor-pointer select-none">
            <input
              type="checkbox"
              class={checkbox}
              checked={amend()}
              onChange={(event) => setAmend(event.currentTarget.checked)}
            />
            {ctx.t("git.commit.amend")}
          </label>
          <span
            class="text-12-regular"
            classList={{
              "text-v2-state-fg-warning": conflicted(),
              "text-v2-text-text-muted": !conflicted(),
            }}
          >
            {hint()}
          </span>
        </div>
        <div class="flex flex-wrap items-center gap-2">
          <button
            type="button"
            data-action="git-commit"
            class={primary}
            disabled={!ready()}
            onClick={() => void commit(false)}
          >
            <Busy when={view.busy() === "commit"}>
              <Icon name="check" size="small" />
            </Busy>
            {amend() ? ctx.t("git.commit.amendSubmit") : ctx.t("git.commit.submit")}
          </button>
          {/* An amended commit that was pushed would need a force push, which this panel never does. */}
          <Tooltip value={ctx.t("git.commit.amendNoPush")} inactive={!amend()} placement="top">
            <button
              type="button"
              data-action="git-commit-push"
              class={secondary}
              disabled={!ready() || amend() || status().remotes.length === 0 || status().detached}
              onClick={() => void commit(true)}
            >
              <Icon name="arrow-up" size="small" />
              {ctx.t("git.commit.submitPush")}
            </button>
          </Tooltip>
          <span class="ms-auto text-[11px] text-v2-text-text-faint @max-[30rem]:hidden">
            {ctx.t("git.commit.shortcut")}
          </span>
        </div>
      </Show>
    </div>
  )
}
