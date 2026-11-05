import { useLanguage } from "@/runtime/i18n/language"
import { BrandIcon } from "@/shell/brand-icon"

/** A screen that is still loading: the app icon breathing in the middle of the area it fills. */
export function BrandLoader() {
  const language = useLanguage()

  return (
    <div
      data-component="brand-loader"
      role="status"
      aria-live="polite"
      aria-label={language.t("common.loading")}
      class="flex min-h-0 flex-1 items-center justify-center"
    >
      <span class="relative flex size-14 items-center justify-center">
        <span data-slot="brand-loader-halo" class="absolute inset-0 rounded-[14px] bg-[#0a3a78]/30" aria-hidden="true" />
        <span data-slot="brand-loader-icon" class="relative">
          <BrandIcon class="size-14 rounded-[14px] shadow-[0_8px_24px_rgb(10_58_120/0.25)]" />
        </span>
      </span>
    </div>
  )
}
