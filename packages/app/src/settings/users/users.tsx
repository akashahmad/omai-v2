import { createMemo, createResource, createSignal, For, Show, type JSX } from "solid-js"
import { createStore, produce, reconcile } from "solid-js/store"
import { Button } from "@opencode/ui/button"
import { Checkbox } from "@opencode/ui/checkbox"
import { Select } from "@opencode/ui/select"
import { TextInput } from "@opencode/ui/text-input"
import { useDialog } from "@opencode/ui/context/dialog"
import { Dialog, DialogFooter, DialogHeader, DialogTitleGroup } from "@opencode/ui/dialog"
import { useLanguage } from "@/runtime/i18n/language"
import { useControlPlane } from "@/controlplane/session"
import { RequestError, type AdminUser, type ModelKey } from "@/controlplane/client"
import { HIDEABLE } from "@/controlplane/restrictions"
import "@/settings/settings.css"

type Draft = { admin: boolean; hidden: string[]; model: ModelKey | null }

type Field = "username" | "email" | "password"

type ModelOption = { id: string; label: string; model: ModelKey | null }

// The same rules the control plane enforces.
const USERNAME = /^[a-zA-Z0-9][a-zA-Z0-9_-]{2,29}$/

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

const PASSWORD_MIN = 12

const modelID = (model: ModelKey | null) => (model ? `${model.providerID}/${model.modelID}` : "none")

/**
 * Settings › Users & Roles, for admins in multi-user mode: add users, make them admins or members, hide parts of the
 * app from a member, and lock a member to one of the shared models.
 */
export function SettingsUsers() {
  const language = useLanguage()
  const dialog = useDialog()
  const session = useControlPlane()
  const client = session.client

  const [users, setUsers] = createStore<AdminUser[]>([])
  const [drafts, setDrafts] = createStore<Record<string, Draft>>({})
  const [form, setForm] = createStore({ username: "", email: "", password: "", admin: false })
  const [failures, setFailures] = createStore<Partial<Record<Field, string>>>({})
  const [attempted, setAttempted] = createSignal(false)
  const [formError, setFormError] = createSignal<string>()
  const [error, setError] = createSignal<string>()
  const [saving, setSaving] = createSignal<string>()

  const [loaded] = createResource(async () => {
    const list = await client.admin.users()
    setUsers(reconcile([...list]))

    return true
  })

  const [shared] = createResource(() => client.models.shared().catch(() => []))

  const modelOptions = createMemo<ModelOption[]>(() => [
    { id: "none", label: language.t("settings.admin.user.model.none"), model: null },
    ...(shared() ?? []).map((model) => ({
      id: modelID(model),
      label: `${model.modelID} (${model.providerID})`,
      model: { providerID: model.providerID, modelID: model.modelID },
    })),
  ])

  const roleOptions = () => [
    { id: "member", label: language.t("settings.admin.role.member") },
    { id: "admin", label: language.t("settings.admin.role.admin") },
  ]

  const self = (user: AdminUser) => user.id === session.state.user?.id

  const draftFor = (user: AdminUser): Draft =>
    drafts[user.id] ?? { admin: user.admin, hidden: [...user.hidden], model: user.model }

  const dirty = (user: AdminUser) => {
    const draft = drafts[user.id]

    if (!draft) return false

    return (
      draft.admin !== user.admin ||
      modelID(draft.model) !== modelID(user.model) ||
      draft.hidden.length !== user.hidden.length ||
      draft.hidden.some((id) => !user.hidden.includes(id))
    )
  }

  const edit = (user: AdminUser, change: (draft: Draft) => void) => {
    if (!drafts[user.id]) setDrafts(user.id, { admin: user.admin, hidden: [...user.hidden], model: user.model })
    setDrafts(user.id, produce(change))
  }

  const discard = (user: AdminUser) =>
    setDrafts(
      produce((all) => {
        delete all[user.id]
      }),
    )

  const describe = (cause: unknown) => {
    const code = cause instanceof RequestError ? cause.code : undefined

    if (code === "self-demote") return language.t("settings.admin.error.selfDemote")

    if (code === "self-delete") return language.t("settings.admin.error.selfDelete")

    if (code === "invalid-model") return language.t("settings.admin.error.model")

    return language.t("settings.admin.error")
  }

  const run = async (key: string, action: () => Promise<void>, onError = (message: string) => setError(message)) => {
    setSaving(key)
    setError(undefined)
    await action()
      .catch((cause: unknown) => onError(describe(cause)))
      .finally(() => setSaving(undefined))
  }

  const save = (user: AdminUser) => {
    const draft = drafts[user.id]

    if (!draft) return

    return run(user.id, async () => {
      const updated = await client.admin.update(user.id, {
        admin: draft.admin,
        hidden: draft.hidden,
        model: draft.model,
      })

      setUsers((item) => item.id === user.id, reconcile(updated))
      discard(user)
    })
  }

  const remove = (user: AdminUser) =>
    dialog.show(() => (
      <Dialog fit>
        <DialogHeader>
          <DialogTitleGroup
            title={language.t("settings.admin.delete")}
            description={language.t("settings.admin.delete.confirm", { username: user.username })}
          />
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={() => dialog.close()}>
            {language.t("common.cancel")}
          </Button>
          <Button
            variant="danger"
            onClick={() => {
              dialog.close()
              void run(user.id, async () => {
                await client.admin.remove(user.id)
                setUsers((list) => list.filter((item) => item.id !== user.id))
                discard(user)
              })
            }}
          >
            {language.t("settings.admin.delete")}
          </Button>
        </DialogFooter>
      </Dialog>
    ))

  const validate = (field: Field) => {
    const value = form[field].trim()

    if (field === "username") {
      if (!value) return language.t("settings.admin.add.error.usernameMissing")

      if (!USERNAME.test(value)) return language.t("settings.admin.add.error.usernameInvalid")

      if (users.some((user) => user.username === value.toLowerCase()))
        return language.t("settings.admin.add.error.usernameTaken")

      return undefined
    }

    if (field === "email") {
      if (!EMAIL.test(value) || value.length > 254) return language.t("settings.admin.add.error.emailInvalid")

      if (users.some((user) => user.email === value.toLowerCase()))
        return language.t("settings.admin.add.error.emailTaken")

      return undefined
    }

    return form.password.length < PASSWORD_MIN ? language.t("settings.admin.add.error.passwordWeak") : undefined
  }

  const fieldError = (field: Field) => failures[field] ?? (attempted() ? validate(field) : undefined)
  const invalid = () => (["username", "email", "password"] as const).some((field) => fieldError(field) !== undefined)
  const filled = () => !!form.username.trim() && !!form.email.trim() && !!form.password

  const create = () => {
    setAttempted(true)

    if (invalid()) return

    return run(
      "create",
      async () => {
        const created = await client.admin.create({
          username: form.username.trim(),
          email: form.email.trim().toLowerCase(),
          password: form.password,
          admin: form.admin,
          hidden: [],
          model: null,
        })

        setUsers(users.length, created)
        setForm({ username: "", email: "", password: "", admin: false })
        setFailures(reconcile({}))
        setFormError(undefined)
        setAttempted(false)
      },
      (message) => setFormError(message),
    ).then(() => undefined)
  }

  const input = (field: Field) => (event: InputEvent & { currentTarget: HTMLInputElement }) => {
    setForm(field, event.currentTarget.value)
    setFailures(field, undefined)
    setFormError(undefined)
  }

  return (
    <>
      <div class="settings-tab-header">
        <div class="settings-tab-header-row">
          <div class="flex flex-col gap-1">
            <h2 class="settings-tab-title">{language.t("settings.admin.title")}</h2>
            <span class="text-11-regular text-v2-text-text-muted">{language.t("settings.admin.description")}</span>
          </div>
        </div>
      </div>

      <div class="settings-tab-body flex flex-col gap-8 pb-10">
        <Show when={error()}>
          <div class="rounded-[8px] border border-[#ef4444]/30 bg-[#ef4444]/10 px-3 py-2 text-[13px] text-[#b91c1c] dark:text-[#fca5a5]">
            {error()}
          </div>
        </Show>

        <section class="flex flex-col gap-3">
          <Heading
            title={language.t("settings.admin.add.title")}
            description={language.t("settings.admin.add.subtitle")}
          />
          <div class="flex flex-col gap-4 rounded-[10px] border border-v2-border-border-base bg-v2-background-bg-base p-4 shadow-[var(--v2-elevation-raised)]">
            <div class="grid grid-cols-1 gap-4 md:grid-cols-2">
              <Labeled
                label={language.t("settings.admin.add.username")}
                hint={language.t("settings.admin.add.hint.username")}
                error={fieldError("username")}
              >
                <TextInput
                  value={form.username}
                  invalid={!!fieldError("username")}
                  onInput={input("username")}
                  spellcheck={false}
                  autocomplete="off"
                  autocapitalize="off"
                />
              </Labeled>
              <Labeled
                label={language.t("settings.admin.add.email")}
                hint={language.t("settings.admin.add.hint.email")}
                error={fieldError("email")}
              >
                <TextInput
                  type="email"
                  value={form.email}
                  invalid={!!fieldError("email")}
                  onInput={input("email")}
                  spellcheck={false}
                  autocomplete="off"
                />
              </Labeled>
              <Labeled
                label={language.t("settings.admin.add.password")}
                hint={language.t("settings.admin.add.hint.password")}
                error={fieldError("password")}
              >
                <TextInput
                  type="password"
                  value={form.password}
                  invalid={!!fieldError("password")}
                  onInput={input("password")}
                  autocomplete="new-password"
                />
              </Labeled>
              <Labeled label={language.t("settings.admin.role")} hint={language.t("settings.admin.add.hint.role")}>
                <Select
                  options={roleOptions()}
                  current={roleOptions().find((option) => option.id === (form.admin ? "admin" : "member"))}
                  value={(option) => option.id}
                  label={(option) => option.label}
                  onSelect={(option) => option && setForm("admin", option.id === "admin")}
                  placement="bottom-start"
                  gutter={6}
                />
              </Labeled>
            </div>
            <div class="flex items-center justify-between gap-3">
              <span class="text-[12px] text-[#dc2626]">{formError()}</span>
              <button
                type="button"
                class="h-8 cursor-pointer rounded-[6px] bg-[#0a3a78] px-3.5 text-[13px] font-[600] text-[#fff] hover:bg-[#082f62] disabled:cursor-not-allowed disabled:opacity-50"
                disabled={saving() !== undefined || !filled()}
                onClick={() => void create()}
              >
                {saving() === "create"
                  ? language.t("settings.admin.add.submitting")
                  : language.t("settings.admin.add.submit")}
              </button>
            </div>
          </div>
        </section>

        <section class="flex flex-col gap-3">
          <Heading
            title={language.t("settings.admin.users.title")}
            description={language.t("settings.admin.users.subtitle")}
          />
          <Show
            when={loaded()}
            fallback={
              <div class="py-6 text-center text-[13px] text-v2-text-text-muted">
                {loaded.error ? language.t("settings.admin.error") : language.t("common.loading")}
              </div>
            }
          >
            <Show
              when={users.length > 0}
              fallback={
                <div class="py-6 text-center text-[13px] text-v2-text-text-muted">
                  {language.t("settings.admin.users.empty")}
                </div>
              }
            >
              <div class="flex flex-col gap-3">
                <For each={users}>
                  {(user) => {
                    const draft = () => draftFor(user)

                    return (
                      <article
                        class="flex flex-col gap-4 rounded-[10px] border bg-v2-background-bg-base p-4 shadow-[var(--v2-elevation-raised)] transition-colors"
                        classList={{
                          "border-[#1a64d6]/60": dirty(user),
                          "border-v2-border-border-base": !dirty(user),
                        }}
                      >
                        <header class="flex flex-wrap items-center justify-between gap-3">
                          <div class="flex min-w-0 items-center gap-3">
                            <span class="flex size-9 shrink-0 items-center justify-center rounded-full bg-[#0a3a78] text-[14px] font-[600] text-[#fff]">
                              {user.username.charAt(0).toUpperCase()}
                            </span>
                            <div class="flex min-w-0 flex-col">
                              <div class="flex items-center gap-2 text-[14px] font-[600] text-v2-text-text-base">
                                <span class="truncate">{user.username}</span>
                                <Show when={self(user)}>
                                  <span class="rounded-full bg-[#1a64d6]/15 px-2 py-0.5 text-[11px] font-[500] text-[#1a64d6]">
                                    {language.t("settings.admin.you")}
                                  </span>
                                </Show>
                                <Show when={user.admin}>
                                  <span class="rounded-full bg-v2-background-bg-layer-02 px-2 py-0.5 text-[11px] font-[500] text-v2-text-text-muted">
                                    {language.t("settings.admin.role.admin")}
                                  </span>
                                </Show>
                              </div>
                              <span class="truncate text-[12px] text-v2-text-text-muted">{user.email}</span>
                            </div>
                          </div>
                          <div class="flex items-center gap-2">
                            <Select
                              options={roleOptions()}
                              current={roleOptions().find(
                                (option) => option.id === (draft().admin ? "admin" : "member"),
                              )}
                              value={(option) => option.id}
                              label={(option) => option.label}
                              onSelect={(option) =>
                                option && edit(user, (next) => void (next.admin = option.id === "admin"))
                              }
                              placement="bottom-end"
                              gutter={6}
                              disabled={self(user)}
                            />
                            <Button
                              variant="ghost-danger"
                              size="small"
                              disabled={self(user) || saving() !== undefined}
                              onClick={() => remove(user)}
                            >
                              {language.t("settings.admin.delete")}
                            </Button>
                          </div>
                        </header>

                        {/* An admin sees everything and every model; the rest only applies to members. */}
                        <Show
                          when={!draft().admin}
                          fallback={
                            <p class="text-[12px] text-v2-text-text-muted">
                              {language.t("settings.admin.adminAccess")}
                            </p>
                          }
                        >
                          <div class="flex flex-col gap-1.5">
                            <span class="text-[12px] font-[600] text-v2-text-text-base">
                              {language.t("settings.admin.user.model")}
                            </span>
                            <div class="flex flex-wrap items-center gap-3">
                              <Select
                                options={modelOptions()}
                                current={modelOptions().find((option) => option.id === modelID(draft().model))}
                                value={(option) => option.id}
                                label={(option) => option.label}
                                onSelect={(option) => option && edit(user, (next) => void (next.model = option.model))}
                                placement="bottom-start"
                                gutter={6}
                              />
                              <span class="text-[12px] text-v2-text-text-muted">
                                {language.t("settings.admin.user.model.hint")}
                              </span>
                            </div>
                          </div>

                          <div class="flex flex-col gap-2">
                            <div class="flex flex-wrap items-baseline justify-between gap-2">
                              <div class="flex flex-col">
                                <span class="text-[12px] font-[600] text-v2-text-text-base">
                                  {language.t("settings.admin.permissions.title")}
                                </span>
                                <span class="text-[12px] text-v2-text-text-muted">
                                  {language.t("settings.admin.permissions.subtitle")}
                                </span>
                              </div>
                              <div class="flex gap-1">
                                <Button
                                  variant="ghost-muted"
                                  size="small"
                                  onClick={() => edit(user, (next) => void (next.hidden = []))}
                                >
                                  {language.t("settings.admin.permissions.all")}
                                </Button>
                                <Button
                                  variant="ghost-muted"
                                  size="small"
                                  onClick={() =>
                                    edit(user, (next) => void (next.hidden = HIDEABLE.map((item) => item.id)))
                                  }
                                >
                                  {language.t("settings.admin.permissions.none")}
                                </Button>
                              </div>
                            </div>
                            <div class="grid grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-2 lg:grid-cols-3">
                              <For each={HIDEABLE}>
                                {(item) => (
                                  <Checkbox
                                    checked={!draft().hidden.includes(item.id)}
                                    onChange={(allowed: boolean) =>
                                      edit(user, (next) => {
                                        next.hidden = allowed
                                          ? next.hidden.filter((id) => id !== item.id)
                                          : [...next.hidden.filter((id) => id !== item.id), item.id]
                                      })
                                    }
                                  >
                                    {language.t(item.label)}
                                  </Checkbox>
                                )}
                              </For>
                            </div>
                          </div>
                        </Show>

                        <footer class="flex items-center justify-end gap-2 border-t border-v2-border-border-muted pt-3">
                          <Show when={dirty(user)}>
                            <span class="me-auto text-[12px] text-[#1a64d6]">
                              {language.t("settings.admin.unsaved")}
                            </span>
                            <Button
                              variant="ghost-muted"
                              size="small"
                              disabled={saving() === user.id}
                              onClick={() => discard(user)}
                            >
                              {language.t("settings.admin.discard")}
                            </Button>
                          </Show>
                          <button
                            type="button"
                            class="h-7 cursor-pointer rounded-[6px] bg-[#0a3a78] px-3 text-[12px] font-[600] text-[#fff] hover:bg-[#082f62] disabled:cursor-not-allowed disabled:opacity-40"
                            disabled={!dirty(user) || saving() !== undefined}
                            onClick={() => void save(user)}
                          >
                            {language.t("settings.admin.save")}
                          </button>
                        </footer>
                      </article>
                    )
                  }}
                </For>
              </div>
            </Show>
          </Show>
        </section>
      </div>
    </>
  )
}

function Heading(props: { title: string; description: string }) {
  return (
    <header class="flex flex-col gap-0.5">
      <h3 class="text-[14px] font-[600] text-v2-text-text-base">{props.title}</h3>
      <p class="text-[12px] text-v2-text-text-muted">{props.description}</p>
    </header>
  )
}

function Labeled(props: { label: string; hint: string; error?: string; children: JSX.Element }) {
  return (
    <label class="flex flex-col gap-1.5">
      <span class="text-[12px] font-[600] text-v2-text-text-base">{props.label}</span>
      {props.children}
      <span
        class="text-[11px]"
        classList={{ "text-[#dc2626]": !!props.error, "text-v2-text-text-muted": !props.error }}
      >
        {props.error ?? props.hint}
      </span>
    </label>
  )
}
