import { createStore, reconcile } from "solid-js/store"
import type { VisibilitySource } from "@/providers/models/models"

type ModelKey = { providerID: string; modelID: string }

const keyOf = (model: ModelKey) => `${model.providerID}:${model.modelID}`

/**
 * The platform's model switches for an admin's Settings > Models: off unless switched on, saved for everyone. Each
 * change saves the whole list, one save after another, so the last switch always wins.
 */
export function createPlatformVisibility(input: {
  load: () => Promise<readonly ModelKey[]>
  save: (models: ModelKey[]) => Promise<void>
}): VisibilitySource & { set(model: ModelKey, visible: boolean): void } {
  // Until the saved list arrives, a switch would save a list missing everything else that is on.
  const [store, setStore] = createStore<{ on: ModelKey[]; loaded: boolean }>({ on: [], loaded: false })
  const queue = { last: Promise.resolve() }

  void input.load().then(
    (models) => setStore({ on: [...models], loaded: true }),
    () => undefined,
  )

  return {
    visible: (model) => store.on.some((item) => keyOf(item) === keyOf(model)),
    set: (model, visible) => {
      if (!store.loaded) return
      const rest = store.on.filter((item) => keyOf(item) !== keyOf(model))
      const next = visible ? [...rest, { providerID: model.providerID, modelID: model.modelID }] : rest
      setStore("on", reconcile(next))
      queue.last = queue.last.then(() => input.save(next)).catch(() => undefined)
    },
  }
}
