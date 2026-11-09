import { A, useNavigate, useSearchParams } from "@solidjs/router"
import { Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/runtime/i18n/language"
import { AuthLayout, Field, inputClass, PasswordInput, submitClass } from "./auth-layout"
import type { Client, User } from "./client"
import { safeNext, useControlPlane } from "./session"

/** The login request, apart from the page so it can be tested on its own. */
export async function submitLogin(
  client: Pick<Client, "login">,
  input: { login: string; password: string },
): Promise<{ user: User } | { error: "auth.login.invalid" | "auth.error.generic" }> {
  const result = await client.login(input).catch(() => "error" as const)

  if (result === "invalid") return { error: "auth.login.invalid" }

  if (result === "error") return { error: "auth.error.generic" }

  return { user: result }
}

export function LoginPage() {
  const session = useControlPlane()
  const language = useLanguage()
  const navigate = useNavigate()
  const [params] = useSearchParams<{ next?: string }>()
  const [form, setForm] = createStore({ login: "", password: "", busy: false, error: undefined as string | undefined })

  const submit = async (event: SubmitEvent) => {
    event.preventDefault()

    if (form.busy) return
    setForm({ busy: true, error: undefined })
    const result = await submitLogin(session.client, { login: form.login, password: form.password })

    if ("error" in result) return setForm({ busy: false, error: language.t(result.error) })
    session.signedIn(result.user)
    navigate(safeNext(params.next), { replace: true })
  }

  return (
    <AuthLayout title={language.t("auth.login.title")} subtitle={language.t("auth.login.subtitle")}>
      <form class="flex flex-col gap-4" onSubmit={submit}>
        <Field label={language.t("auth.login.identifier")}>
          <input
            name="login"
            required
            autocomplete="username"
            class={inputClass}
            value={form.login}
            onInput={(event) => setForm("login", event.currentTarget.value)}
          />
        </Field>
        <Field label={language.t("auth.password")}>
          <PasswordInput
            name="password"
            autocomplete="current-password"
            value={form.password}
            onInput={(value) => setForm("password", value)}
          />
        </Field>
        <Show when={form.error}>
          <p role="alert" class="text-[13px] text-[#c62828] dark:text-[#ff8a80]">
            {form.error}
          </p>
        </Show>
        <button type="submit" class={submitClass} disabled={form.busy}>
          {language.t("auth.login.submit")}
        </button>
        <Show when={session.state.signupEnabled}>
          <p class="text-center text-[13px] text-v2-text-text-muted">
            {language.t("auth.login.noAccount")}{" "}
            <A href="/signup" class="cursor-pointer font-[530] text-[#1a64d6] hover:underline">
              {language.t("auth.login.signupLink")}
            </A>
          </p>
        </Show>
      </form>
    </AuthLayout>
  )
}
