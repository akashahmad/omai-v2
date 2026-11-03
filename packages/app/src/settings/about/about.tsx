import { createEffect, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { useDialog } from "@opencode/ui/context/dialog"
import { Tooltip } from "@opencode/ui/tooltip"
import { Logo } from "@opencode/ui/logo"
import { useLanguage } from "@/runtime/i18n/language"
import { usePlatform } from "@/runtime/platform/platform"
import { showToast } from "@/shell/notifications/toast"

export function SettingsAbout(props: { active: boolean }) {
  const language = useLanguage()
  const platform = usePlatform()
  const dialog = useDialog()
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

  const showNotices = async () => {
    // The license texts load only when someone reads them.
    const loaded = await import("./notices/dialog").catch(() => undefined)

    if (!loaded) {
      showToast({ variant: "error", title: language.t("settings.about.notices.loadFailed") })

      return
    }

    void dialog.show(() => <loaded.default />)
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

      <Logo class="w-60 max-w-full" />

      <div class="settings-about-details">
        <p>{language.t("settings.about.description")}</p>
        <p>{language.t("settings.about.typeset")}</p>
        <p>
          <button type="button" class="settings-about-link" onClick={() => void showNotices()}>
            {language.t("settings.about.notices.title")}
          </button>
        </p>
      </div>
    </div>
  )
}
