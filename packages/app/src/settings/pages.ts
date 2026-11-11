import type { IconProps } from "@opencode/ui/icon"
import type { useLanguage } from "@/runtime/i18n/language"
import type { SettingsRootTab } from "./surface"

export const pageIcons = {
  general: "sliders",
  appearance: "appearance",
  notifications: "notifications",
  shortcuts: "keyboard",
  providers: "providers",
  models: "models",
  "shared-providers": "providers",
  "shared-models": "models",
  users: "shield",
  extensions: "extensions",
  servers: "server",
  experimental: "flask",
} as const satisfies Record<SettingsRootTab, IconProps["name"]>

export const pageLabels = {
  general: "settings.tab.preferences",
  appearance: "settings.general.section.appearance",
  notifications: "settings.tab.notifications",
  shortcuts: "settings.shortcuts.title",
  providers: "settings.providers.title",
  models: "settings.models.title",
  "shared-providers": "settings.sharedProviders.title",
  "shared-models": "settings.sharedModels.title",
  users: "settings.admin.title",
  extensions: "settings.tab.extensions",
  servers: "settings.section.server",
  experimental: "settings.tab.experimental",
} as const satisfies Record<SettingsRootTab, Parameters<ReturnType<typeof useLanguage>["t"]>[0]>
