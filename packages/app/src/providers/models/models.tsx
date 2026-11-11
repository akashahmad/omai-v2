import { useControlPlaneOptional } from "@/controlplane/session"
import { createSharedVisibility } from "@/controlplane/shared-models"
import { type Accessor, createMemo } from "solid-js"
import { createSimpleContext } from "@opencode/ui/context"
import { useProviders } from "@/providers/catalog/providers"
import { useGlobal } from "@/runtime/server/runtime"

type ModelKey = { providerID: string; modelID: string }

type Visibility = "show" | "hide"

const RECENT_LIMIT = 5

function modelKey(model: ModelKey) {
  return `${model.providerID}:${model.modelID}`
}

export const isFreeModel = (model: { cost?: { input: number } }) => model.cost?.input === 0

export function uniqueModels(models: ModelKey[]) {
  const seen = new Set<string>()

  return models.filter((model) => {
    const key = modelKey(model)

    if (seen.has(key)) return false
    seen.add(key)

    return true
  })
}

/**
 * Where a model's on/off switch lives when not (only) in this browser. `visible` answering undefined, or no `set`,
 * leaves that model to the browser's own switches.
 */
export type VisibilitySource = {
  visible(model: ModelKey): boolean | undefined
  set?(model: ModelKey, visible: boolean): void
}

const createModelsController = (
  directory: Accessor<string | undefined>,
  source: Accessor<VisibilitySource | undefined>,
) => {
  const providers = useProviders(() => directory())
  const models = useGlobal().models
  const store = models.store
  const setStore = models.set

  const available = createMemo(() =>
    providers.connected().flatMap((p) =>
      Object.values(p.models).map((m) => ({
        ...m,
        provider: p,
      })),
    ),
  )

  const visibility = createMemo(() => {
    const map = new Map<string, Visibility>()

    for (const item of store.user) map.set(`${item.providerID}:${item.modelID}`, item.visibility)

    return map
  })

  const list = createMemo(() =>
    available().map((m) => ({
      ...m,
      name: m.name.replace("(latest)", "").trim(),
      latest: m.name.includes("(latest)"),
    })),
  )

  const find = (key: ModelKey) => list().find((m) => m.id === key.modelID && m.provider.id === key.providerID)

  function update(model: ModelKey, state: Visibility) {
    const index = store.user.findIndex((x) => x.modelID === model.modelID && x.providerID === model.providerID)

    if (index >= 0) {
      setStore("user", index, (current) => ({ ...current, visibility: state }))

      return
    }

    setStore("user", store.user.length, { ...model, visibility: state })
  }

  const visible = (model: ModelKey) => {
    const decided = source()?.visible(model)

    if (decided !== undefined) return decided

    // Every model shows until its switch is turned off.
    return visibility().get(modelKey(model)) !== "hide"
  }

  const setVisibility = (model: ModelKey, state: boolean) => {
    const override = source()?.set

    if (override) return override(model, state)
    update(model, state ? "show" : "hide")
  }

  const push = (model: ModelKey) => {
    const uniq = uniqueModels([model, ...store.recent])

    if (uniq.length > RECENT_LIMIT) uniq.pop()
    setStore("recent", uniq)
  }

  // Newest favorite first, as in the TUI.
  const toggleFavorite = (model: ModelKey) => {
    const key = modelKey(model)
    const rest = store.favorite.filter((item) => modelKey(item) !== key)

    setStore(
      "favorite",
      rest.length === store.favorite.length
        ? [{ providerID: model.providerID, modelID: model.modelID }, ...rest]
        : rest,
    )
  }

  const variantKey = (model: ModelKey) => `${model.providerID}/${model.modelID}`
  const getVariant = (model: ModelKey) => store.variant?.[variantKey(model)]

  const setVariant = (model: ModelKey, value: string | undefined) => {
    const key = variantKey(model)

    if (!store.variant) {
      setStore("variant", { [key]: value ?? "default" })

      return
    }

    setStore("variant", key, value ?? "default")
  }

  return {
    ready: models.ready,
    list,
    find,
    visible,
    setVisibility,
    recent: {
      list: models.recent,
      push,
    },
    favorite: {
      list: models.favorite,
      toggle: toggleFavorite,
    },
    variant: {
      get: getVariant,
      set: setVariant,
    },
  }
}

export const { use: useModels, provider: ModelsProvider } = createSimpleContext({
  name: "Models",
  gate: false,
  init: (props: { directory?: string; visibility?: VisibilitySource } = {}) => {
    const session = useControlPlaneOptional()
    // Multi-user mode: the models an admin shared always show; the user's own follow their switches.
    const shared = session
      ? createSharedVisibility({
          shared: () => session.client.models.shared(),
          mine: () => session.client.models.mine(),
          save: (item) => session.client.models.setMine(item),
        })
      : undefined

    return createModelsController(
      () => props.directory,
      () => props.visibility ?? shared,
    )
  },
})
