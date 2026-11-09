import { createStore } from "solid-js/store"
import type { VisibilitySource } from "@/providers/models/models"

type ModelKey = { providerID: string; modelID: string }

const keyOf = (model: ModelKey) => `${model.providerID}:${model.modelID}`

/**
 * Multi-user mode: the models an admin shared always show in a project's picker; every other model (the user's own
 * providers) follows the user's own Models switches.
 */
export function createSharedVisibility(load: () => Promise<readonly ModelKey[]>): VisibilitySource {
  const [store, setStore] = createStore<{ shared: string[] }>({ shared: [] })

  void load().then(
    (models) => setStore("shared", models.map(keyOf)),
    () => undefined,
  )

  return { visible: (model) => (store.shared.includes(keyOf(model)) ? true : undefined) }
}
