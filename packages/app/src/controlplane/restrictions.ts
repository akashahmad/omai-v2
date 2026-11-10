import { createStore } from "solid-js/store"
import type { ModelKey, User } from "./client"

/** The name a user locked to one model sees in its place. */
export const LOCKED_MODEL_LABEL = "O M A I +"

/**
 * The parts of the app an admin can hide from a user: built-in panels by their plugin id, and settings pages as
 * `settings:<page>`. Labels are i18n keys.
 */
export const HIDEABLE = [
  { id: "preview", label: "settings.admin.scope.preview" },
  { id: "file", label: "settings.admin.scope.files" },
  { id: "review", label: "settings.admin.scope.review" },
  { id: "terminal", label: "settings.admin.scope.terminal" },
  { id: "context", label: "settings.admin.scope.context" },
  { id: "tools", label: "settings.admin.scope.tools" },
  { id: "details", label: "settings.admin.scope.details" },
  { id: "sources", label: "settings.admin.scope.sources" },
  { id: "btw", label: "settings.admin.scope.btw" },
  { id: "settings:providers", label: "settings.admin.scope.providers" },
  { id: "settings:models", label: "settings.admin.scope.models" },
  { id: "settings:extensions", label: "settings.admin.scope.extensions" },
  { id: "settings:shortcuts", label: "settings.admin.scope.shortcuts" },
  { id: "settings:servers", label: "settings.admin.scope.servers" },
] as const

// The signed-in user's restrictions. Module state, because the plugin host that hides panels mounts above the
// control plane session that knows the user.
const [store, setStore] = createStore<{ hidden: readonly string[]; model: ModelKey | undefined }>({
  hidden: [],
  model: undefined,
})

export const restrictions = {
  /** Whether an admin hid this plugin or `settings:<page>` from the signed-in user. */
  hidden: (id: string) => store.hidden.includes(id),
  /** Every hidden plugin id. */
  plugins: () => store.hidden.filter((id) => !id.startsWith("settings:")),
  /** The one model the signed-in user is locked to. */
  model: () => store.model,
}

/** Applies the signed-in user's restrictions; none once signed out. Admins are never restricted. */
export function applyRestrictions(user: User | undefined) {
  setStore({
    hidden: user && !user.admin ? [...(user.hidden ?? [])] : [],
    model: user && !user.admin ? (user.model ?? undefined) : undefined,
  })
}
