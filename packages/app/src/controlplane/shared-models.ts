import { createStore } from "solid-js/store"
import type { VisibilitySource } from "@/providers/models/models"

type ModelKey = { providerID: string; modelID: string }
type Switch = ModelKey & { visible: boolean }

const keyOf = (model: ModelKey) => `${model.providerID}:${model.modelID}`

/**
 * Multi-user mode: the models an admin shared always show in a project's picker. Every other model (the user's own
 * providers) follows the user's own Models switches, kept on their account so all their projects and browsers agree;
 * a model they never switched falls back to the browser's defaults.
 */
export function createSharedVisibility(input: {
  shared: () => Promise<readonly ModelKey[]>
  mine: () => Promise<readonly Switch[]>
  save: (item: Switch) => Promise<void>
}): VisibilitySource {
  const [store, setStore] = createStore<{ shared: string[]; mine: Record<string, boolean> }>({ shared: [], mine: {} })
  // Saved one after another, so the last switch is the one the account keeps.
  const queue = { last: Promise.resolve() }

  void input.shared().then(
    (models) => setStore("shared", models.map(keyOf)),
    () => undefined,
  )
  void input.mine().then(
    // A switch made while the list loaded is newer than the list.
    (list) =>
      setStore("mine", (current) => ({
        ...Object.fromEntries(list.map((item) => [keyOf(item), item.visible])),
        ...current,
      })),
    () => undefined,
  )

  return {
    visible: (model) => (store.shared.includes(keyOf(model)) ? true : store.mine[keyOf(model)]),
    set: (model, visible) => {
      setStore("mine", keyOf(model), visible)
      const item = { providerID: model.providerID, modelID: model.modelID, visible }
      queue.last = queue.last.then(() => input.save(item)).catch(() => undefined)
    },
  }
}
