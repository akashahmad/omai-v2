import { For, type JSX, type ParentProps } from "solid-js"
import { normalizeLocale, useLanguage } from "@/runtime/i18n/language"

/** Login and signup: the form on the left, the O M A I + pitch on the right (hidden on small screens). */
export function AuthLayout(props: ParentProps<{ title: string; subtitle: string }>) {
  const language = useLanguage()

  return (
    <div class="flex min-h-dvh w-full bg-v2-background-bg-base text-v2-text-text-base">
      <div class="flex min-h-dvh w-full flex-col px-6 py-6 md:w-1/2 md:px-12 md:py-8">
        <div class="text-[22px] font-[500] tracking-[0.45em] text-v2-text-text-base">
          O M A I <span class="text-[#1a64d6]">+</span>
        </div>
        <div class="mx-auto flex w-full max-w-[440px] flex-1 flex-col justify-center py-10">
          <div class="text-[12px] font-[600] tracking-[0.2em] text-[#1a64d6] uppercase">
            {language.t("auth.secureAccess")}
          </div>
          <h1 class="mt-3 text-[34px] leading-[42px] font-[650] tracking-[-0.02em] md:text-[42px] md:leading-[50px]">
            {props.title}
          </h1>
          <p class="mt-3 text-[15px] leading-[24px] text-v2-text-text-muted">{props.subtitle}</p>
          <div class="mt-8">{props.children}</div>
        </div>
        <div class="flex items-center justify-between gap-4">
          <div class="text-[12px] text-v2-text-text-muted">{language.t("auth.footer")}</div>
          <LanguagePicker />
        </div>
      </div>
      <Hero />
    </div>
  )
}

/** A pill showing the current language; the native select inside it opens the list, so it works with keyboard and touch. */
function LanguagePicker() {
  const language = useLanguage()

  return (
    <label class="relative flex h-10 shrink-0 cursor-pointer items-center gap-2 rounded-full border border-v2-border-border-base bg-v2-background-bg-base px-4 text-[13px] text-v2-text-text-base hover:border-[#1a64d6]/50">
      <svg
        class="size-4 text-v2-text-text-muted"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.6"
        aria-hidden="true"
      >
        <circle cx="12" cy="12" r="9" />
        <path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3Z" />
      </svg>
      <span>{language.label(language.locale())}</span>
      <svg
        class="size-3.5 text-v2-text-text-muted"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        aria-hidden="true"
      >
        <path d="m6 9 6 6 6-6" />
      </svg>
      <select
        aria-label={language.t("auth.language")}
        class="absolute inset-0 cursor-pointer opacity-0"
        value={language.locale()}
        onChange={(event) => language.setLocale(normalizeLocale(event.currentTarget.value))}
      >
        <For each={language.locales}>{(locale) => <option value={locale}>{language.label(locale)}</option>}</For>
      </select>
    </label>
  )
}

function Hero() {
  const language = useLanguage()

  return (
    <div class="relative hidden w-1/2 overflow-hidden bg-[linear-gradient(160deg,#f7f9ff_0%,#eef2ff_45%,#e3e9ff_75%,#dcdcff_100%)] md:flex dark:bg-[linear-gradient(160deg,#0b1220_0%,#0e1830_50%,#141c3d_100%)]">
      <div class="pointer-events-none absolute -top-[10%] -right-[15%] size-[70%] rounded-full bg-[radial-gradient(circle,#c9d8ff_0%,transparent_65%)] opacity-70 dark:opacity-20" />
      <div class="pointer-events-none absolute -right-[10%] -bottom-[15%] size-[60%] rounded-full bg-[radial-gradient(circle,#d9d2ff_0%,transparent_65%)] opacity-70 dark:opacity-20" />
      <svg
        class="pointer-events-none absolute inset-0 size-full"
        viewBox="0 0 600 800"
        preserveAspectRatio="none"
        fill="none"
        aria-hidden="true"
      >
        <circle cx="640" cy="90" r="460" stroke="#1a64d6" stroke-opacity="0.14" />
        <circle cx="560" cy="980" r="380" stroke="#1a64d6" stroke-opacity="0.12" />
      </svg>
      <div class="relative my-auto flex max-w-[720px] flex-col px-[8%]">
        <div class="text-[13px] font-[700] tracking-[0.4em] text-[#1a64d6]">{language.t("auth.hero.eyebrow")}</div>
        <h2 class="mt-6 text-[36px] leading-[1.1] font-[650] tracking-[-0.03em] text-[#0b1a33] lg:text-[46px] xl:text-[54px] dark:text-[#fff]">
          {language.t("auth.hero.before")}
          <span class="bg-[linear-gradient(90deg,#4f8dff_0%,#5b6cff_60%,#6c5cf5_100%)] bg-clip-text text-transparent">
            {language.t("auth.hero.highlight")}
          </span>
          {language.t("auth.hero.after")}
        </h2>
        <p class="mt-8 max-w-[520px] text-[17px] leading-[30px] text-[#5a6782] lg:text-[19px] dark:text-[#b8c7e0]">
          {language.t("auth.hero.body")}
        </p>
        <div class="mt-14 flex items-center gap-6 text-[13px] font-[650] tracking-[0.22em] text-[#0b1a33] uppercase dark:text-[#dbe6ff]">
          <span>{language.t("auth.hero.think")}</span>
          <span class="h-px w-16 bg-[#1a64d6]/40" aria-hidden="true" />
          <span>{language.t("auth.hero.prompt")}</span>
          <span class="h-px w-16 bg-[#1a64d6]/40" aria-hidden="true" />
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
