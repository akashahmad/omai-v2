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
  /** A load that kept failing, or a save that failed: the admin is told, as a switch would otherwise look saved. */
  failed?: (kind: "load" | "save") => void
  /** Pause between load attempts; tests shorten it. */
  retryMs?: number
}): VisibilitySource & { set(model: ModelKey, visible: boolean): void } {
  // Until the saved list arrives, a switch would save a list missing everything else that is on.
  const [store, setStore] = createStore<{ on: ModelKey[]; loaded: boolean }>({ on: [], loaded: false })
  const queue = { last: Promise.resolve() }

  // A platform server that is still starting can't answer yet, so the list is asked for a few times.
  const load = (attempt = 1): Promise<void> =>
    input.load().then(
      (models) => setStore({ on: [...models], loaded: true }),
      () => {
        if (attempt >= LOAD_ATTEMPTS) return input.failed?.("load")

        return new Promise((resolve) => setTimeout(resolve, input.retryMs ?? RETRY_MS)).then(() => load(attempt + 1))
      },
    )

  void load()

  return {
    visible: (model) => store.on.some((item) => keyOf(item) === keyOf(model)),
    set: (model, visible) => {
      if (!store.loaded) return
      const rest = store.on.filter((item) => keyOf(item) !== keyOf(model))
      const next = visible ? [...rest, { providerID: model.providerID, modelID: model.modelID }] : rest
      setStore("on", reconcile(next))
      queue.last = queue.last.then(() =>
        input.save(next).catch(() => {
          // The switches show what was saved, not what failed to be.
          input.failed?.("save")

          return load()
        }),
      )
    },
  }
}

const LOAD_ATTEMPTS = 4

const RETRY_MS = 2000
