import { createEffect, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { Tooltip } from "@opencode/ui/tooltip"
import { BrandIcon } from "@/shell/brand-icon"
import { useLanguage } from "@/runtime/i18n/language"
import { usePlatform } from "@/runtime/platform/platform"
import { showToast } from "@/shell/notifications/toast"

export function SettingsAbout(props: { active: boolean }) {
  const language = useLanguage()
  const platform = usePlatform()
  const [copy, setCopy] = createStore({ pending: false, copied: false, forceCopied: false })
  const version = () => (platform.version ? `v${platform.version}` : language.t("settings.about.devVersion"))
  const versionLabel = () => language.t("settings.about.version", { version: version() })

  createEffect(() => {
    if (!copy.copied) return

    const close = setTimeout(() => setCopy("forceCopied", false), 2000)
    const reset = setTimeout(() => setCopy("copied", false), 2120)

    onCleanup(() => {
      clearTimeout(close)
      clearTimeout(reset)
    })
  })

  const copyVersion = async () => {
    if (copy.pending) return

    setCopy({ pending: true, copied: false, forceCopied: false })

    await (platform.writeClipboardText?.(versionLabel()) ?? navigator.clipboard.writeText(versionLabel()))
      .then(() => setCopy({ copied: true, forceCopied: true }))
      .catch(() =>
        showToast({
          variant: "error",
          title: language.t("settings.about.copyVersionFailed"),
        }),
      )
      .finally(() => setCopy("pending", false))
  }

  return (
    <div class="settings-about-content">
      <div class="settings-about-intro">
        <div class="settings-about-version-line">
          <Tooltip
            value={language.t(copy.copied ? "common.copied" : "ui.message.copy")}
            placement="top"
            forceOpen={copy.forceCopied ? true : undefined}
          >
            <button
              type="button"
              class="settings-about-version"
              disabled={copy.pending}
              aria-label={language.t(copy.copied ? "common.copied" : "ui.message.copy")}
              onClick={() => void copyVersion()}
            >
              <span>
                {language.rich("settings.about.version", {
                  version: <bdi dir="ltr">{version()}</bdi>,
                })}
              </span>
            </button>
          </Tooltip>
        </div>
      </div>

      <BrandIcon label="O M A I +" class="size-20 rounded-[12px]" />

      <div class="settings-about-details">
        <p>{language.t("settings.about.description")}</p>
        <p class="max-w-[440px] text-v2-text-text-muted">{language.t("settings.about.summary")}</p>
      </div>
    </div>
  )
}
