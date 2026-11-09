import { Plugin } from "@opencode/plugin/gui"
import { builtinCatalog } from "@opencode/plugin/gui/builtin"
import en from "./i18n/en"

/** Read-only previews of Word, Excel and PowerPoint files in the file view. */
export default Plugin.define({
  i18n: builtinCatalog({
    en,
    br: () => import("./i18n/br"),
    de: () => import("./i18n/de"),
    es: () => import("./i18n/es"),
    fr: () => import("./i18n/fr"),
    it: () => import("./i18n/it"),
    ja: () => import("./i18n/ja"),
    ko: () => import("./i18n/ko"),
    nl: () => import("./i18n/nl"),
    pl: () => import("./i18n/pl"),
    ru: () => import("./i18n/ru"),
    tr: () => import("./i18n/tr"),
    zh: () => import("./i18n/zh"),
  }),
})
