import { A, Navigate, useNavigate } from "@solidjs/router"
import { Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/runtime/i18n/language"
import { AuthLayout, Field, inputClass, PasswordInput, submitClass } from "./auth-layout"
import { useControlPlane } from "./session"

export function SignupPage() {
  const session = useControlPlane()
  const language = useLanguage()
  const navigate = useNavigate()

  const [form, setForm] = createStore({
    username: "",
    email: "",
    password: "",
    confirm: "",
    busy: false,
    error: undefined as string | undefined,
  })

  const submit = async (event: SubmitEvent) => {
    event.preventDefault()

    if (form.busy) return

    if (form.password !== form.confirm) return setForm("error", language.t("auth.signup.mismatch"))
    setForm({ busy: true, error: undefined })

    const result = await session.client
      .signup({ username: form.username, email: form.email, password: form.password })
      .catch(() => "error" as const)

    if (typeof result === "object") {
      session.signedIn(result)

      return navigate("/", { replace: true })
    }

    if (result === "disabled") return navigate("/login", { replace: true })

    const key =
      result === "exists" ? "auth.signup.exists" : result === "invalid" ? "auth.signup.invalid" : "auth.error.generic"

    setForm({ busy: false, error: language.t(key) })
  }

  return (
    <Show when={session.state.signupEnabled} fallback={<Navigate href="/login" />}>
      <AuthLayout title={language.t("auth.signup.title")} subtitle={language.t("auth.signup.subtitle")}>
        <form class="flex flex-col gap-4" onSubmit={submit}>
          <Field label={language.t("auth.signup.username")}>
            <input
              name="username"
              required
              autocomplete="username"
              class={inputClass}
              value={form.username}
              onInput={(event) => setForm("username", event.currentTarget.value)}
            />
          </Field>
          <Field label={language.t("auth.signup.email")}>
            <input
              name="email"
              type="email"
              required
              autocomplete="email"
              class={inputClass}
              value={form.email}
              onInput={(event) => setForm("email", event.currentTarget.value)}
            />
          </Field>
          <Field label={language.t("auth.password")}>
            <PasswordInput
              name="password"
              autocomplete="new-password"
              value={form.password}
              onInput={(value) => setForm("password", value)}
            />
          </Field>
          <Field label={language.t("auth.signup.confirm")}>
            <PasswordInput
              name="confirm"
              autocomplete="new-password"
              value={form.confirm}
              onInput={(value) => setForm("confirm", value)}
            />
          </Field>
          <Show when={form.error}>
            <p role="alert" class="text-[13px] text-[#c62828] dark:text-[#ff8a80]">
              {form.error}
            </p>
          </Show>
          <button type="submit" class={submitClass} disabled={form.busy}>
            {language.t("auth.signup.submit")}
          </button>
          <p class="text-center text-[13px] text-v2-text-text-muted">
            {language.t("auth.signup.haveAccount")}{" "}
            <A href="/login" class="cursor-pointer font-[530] text-[#1a64d6] hover:underline">
              {language.t("auth.signup.loginLink")}
            </A>
          </p>
        </form>
      </AuthLayout>
    </Show>
  )
}
