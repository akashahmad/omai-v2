// Who Git records as the author of a commit, for this project or for every project.

import { createSignal, Show } from "solid-js"
import { usePlugin } from "@opencode/plugin/gui"
import { Busy, primary, secondary } from "../ui"
import { checkbox, field } from "./ui"
import type { GitView } from "./view"

export function ProfileForm(props: { view: GitView; onDone?: () => void; onResult: (message?: string) => void }) {
  const ctx = usePlugin()
  const profile = () => props.view.status().profile
  const [name, setName] = createSignal(profile().name ?? "")
  const [email, setEmail] = createSignal(profile().email ?? "")
  const [global, setGlobal] = createSignal(profile().scope === "global")
  const valid = () => name().trim().length > 0 && /^[^\s@]+@[^\s@]+$/.test(email().trim())

  const save = async () => {
    if (!valid() || props.view.busy()) return
    const saved = await props.view.saveProfile({ name: name().trim(), email: email().trim(), global: global() })

    if (!saved) return
    props.onResult(ctx.t("git.profile.saved"))
    props.onDone?.()
  }

  return (
    <form
      data-slot="git-profile"
      class="flex flex-col gap-2.5"
      onSubmit={(event) => {
        event.preventDefault()
        void save()
      }}
    >
      <div class="grid grid-cols-[repeat(auto-fit,minmax(160px,1fr))] gap-2">
        <label class="flex flex-col gap-1 min-w-0">
          <span class="text-12-medium text-v2-text-text-muted">{ctx.t("git.profile.name")}</span>
          <input
            class={field}
            value={name()}
            autocomplete="name"
            placeholder={ctx.t("git.profile.name.placeholder")}
            onInput={(event) => setName(event.currentTarget.value)}
          />
        </label>
        <label class="flex flex-col gap-1 min-w-0">
          <span class="text-12-medium text-v2-text-text-muted">{ctx.t("git.profile.email")}</span>
          <input
            class={field}
            type="email"
            value={email()}
            autocomplete="email"
            spellcheck={false}
            placeholder={ctx.t("git.profile.email.placeholder")}
            onInput={(event) => setEmail(event.currentTarget.value)}
          />
        </label>
      </div>
      <label class="flex items-center gap-2 text-12-regular text-v2-text-text-base cursor-pointer select-none">
        <input
          type="checkbox"
          class={checkbox}
          checked={global()}
          onChange={(event) => setGlobal(event.currentTarget.checked)}
        />
        {ctx.t("git.profile.global")}
      </label>
      <div class="flex items-center gap-2">
        <button type="submit" data-action="git-profile-save" class={primary} disabled={!valid() || !!props.view.busy()}>
          <Busy when={props.view.busy() === "profile"}>{null}</Busy>
          {ctx.t("git.profile.save")}
        </button>
        <Show when={props.onDone}>
          {(done) => (
            <button type="button" class={secondary} onClick={() => done()()}>
              {ctx.t("git.cancel")}
            </button>
          )}
        </Show>
      </div>
    </form>
  )
}
