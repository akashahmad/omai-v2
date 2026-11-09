import type { JSX, ParentProps } from "solid-js"
import { useLanguage } from "@/runtime/i18n/language"

/** Login and signup: the form on the left, the O M A I + pitch on the right (hidden on small screens). */
export function AuthLayout(props: ParentProps<{ title: string; subtitle: string }>) {
  const language = useLanguage()

  return (
    <div class="flex min-h-dvh w-full bg-v2-background-bg-base text-v2-text-text-base">
      <div class="flex min-h-dvh w-full flex-col px-6 py-6 md:w-1/2 md:px-12">
        <div class="text-[15px] font-[600] tracking-[0.35em] text-v2-text-text-base">O M A I +</div>
        <div class="mx-auto flex w-full max-w-[400px] flex-1 flex-col justify-center py-10">
          <div class="text-[11px] font-[600] tracking-[0.14em] text-[#1a64d6] uppercase">
            {language.t("auth.secureAccess")}
          </div>
          <h1 class="mt-2 text-[28px] leading-[36px] font-[600]">{props.title}</h1>
          <p class="mt-2 text-[14px] leading-[20px] text-v2-text-text-muted">{props.subtitle}</p>
          <div class="mt-8">{props.children}</div>
        </div>
        <div class="text-[12px] text-v2-text-text-muted">{language.t("auth.footer")}</div>
      </div>
      <Hero />
    </div>
  )
}

function Hero() {
  const language = useLanguage()

  return (
    <div class="relative hidden w-1/2 overflow-hidden bg-[linear-gradient(135deg,#eef5ff_0%,#dbe9ff_55%,#c7dcff_100%)] md:flex dark:bg-[linear-gradient(135deg,#0b1a33_0%,#0d2347_55%,#10305f_100%)]">
      <svg class="pointer-events-none absolute inset-0 size-full" viewBox="0 0 600 800" fill="none" aria-hidden="true">
        <circle cx="560" cy="120" r="260" stroke="#1a64d6" stroke-opacity="0.18" />
        <circle cx="80" cy="760" r="320" stroke="#1a64d6" stroke-opacity="0.14" />
      </svg>
      <div class="relative m-auto flex max-w-[460px] flex-col px-10">
        <div class="text-[12px] font-[600] tracking-[0.35em] text-[#1a64d6]">{language.t("auth.hero.eyebrow")}</div>
        <h2 class="mt-4 text-[32px] leading-[40px] font-[600] text-[#0b1a33] dark:text-[#fff]">
          {language.t("auth.hero.before")}
          <span class="text-[#1a64d6]">{language.t("auth.hero.highlight")}</span>
          {language.t("auth.hero.after")}
        </h2>
        <p class="mt-4 text-[15px] leading-[22px] text-[#33415c] dark:text-[#b8c7e0]">{language.t("auth.hero.body")}</p>
        <div class="mt-10 flex items-center gap-3 text-[12px] font-[600] tracking-[0.14em] text-[#0a3a78] uppercase dark:text-[#8fb5ff]">
          <span>{language.t("auth.hero.think")}</span>
          <span aria-hidden="true">—</span>
          <span>{language.t("auth.hero.prompt")}</span>
          <span aria-hidden="true">—</span>
          <span>{language.t("auth.hero.build")}</span>
        </div>
      </div>
    </div>
  )
}

export function Field(props: { label: string; children: JSX.Element }) {
  return (
    <label class="flex flex-col gap-1.5">
      <span class="text-[13px] font-[530]">{props.label}</span>
      {props.children}
    </label>
  )
}

export const inputClass =
  "h-10 w-full rounded-[6px] border border-v2-border-border-base bg-v2-background-bg-base px-3 text-[14px] text-v2-text-text-base outline-none focus:border-[#1a64d6] focus:ring-2 focus:ring-[#1a64d6]/25"

export const brandButton =
  "flex h-10 cursor-pointer items-center justify-center rounded-[6px] bg-[#0a3a78] px-4 text-[14px] font-[600] text-[#fff] hover:bg-[#082f62] disabled:cursor-default disabled:opacity-60"

export const submitClass = `${brandButton} mt-2 w-full`

export function PasswordInput(props: {
  value: string
  onInput: (value: string) => void
  autocomplete: string
  name: string
}) {
  const language = useLanguage()
  let input: HTMLInputElement | undefined

  return (
    <div class="relative">
      <input
        ref={input}
        type="password"
        name={props.name}
        required
        autocomplete={props.autocomplete}
        class={`${inputClass} pr-16`}
        value={props.value}
        onInput={(event) => props.onInput(event.currentTarget.value)}
      />
      <button
        type="button"
        class="absolute top-1/2 right-2 -translate-y-1/2 cursor-pointer rounded-[4px] px-2 py-1 text-[12px] text-v2-text-text-muted hover:text-v2-text-text-base"
        onClick={(event) => {
          if (!input) return
          const show = input.type === "password"
          input.type = show ? "text" : "password"
          event.currentTarget.textContent = language.t(show ? "auth.password.hide" : "auth.password.show")
        }}
      >
        {language.t("auth.password.show")}
      </button>
    </div>
  )
}
