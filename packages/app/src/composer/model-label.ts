export type ComposerModelLabel = { provider?: string; model: string }

type Provider = {
  id: string
  name: string
  canonical?: string
  integrationID?: string
  models: Readonly<Record<string, { id: string; name: string }>>
}

export function composerModelLabelKey(providerID: string, modelID: string) {
  return JSON.stringify([providerID, modelID])
}

export function composerProviderName(providerID: string, catalog: ReadonlyMap<string, Provider>) {
  return catalog.get(providerID)?.name ?? providerID
}

export function composerModelLabels(
  catalog: ReadonlyMap<string, Provider>,
  connected?: readonly string[],
): ReadonlyMap<string, ComposerModelLabel> {
  const active = connected && new Set(connected)

  const rows = [...catalog.values()]
    .filter((provider) => !active || active.has(provider.id))
    .flatMap((provider) => {
      const name = composerProviderName(provider.id, catalog)

      return Object.values(provider.models).map((model) => {
        const label = model.name.replace("(latest)", "").trim()

        return {
          key: composerModelLabelKey(provider.id, model.id),
          providerID: provider.id,
          modelID: model.id,
          provider: name,
          model: label,
          text: name ? `${name} / ${label}` : label,
        }
      })
    })

  const groups = Map.groupBy(rows, (row) => row.text)

  return new Map(
    rows.map((row) => {
      const peers = groups.get(row.text) ?? []
      const provider = peers.some((other) => other.providerID !== row.providerID) ? row.providerID : row.provider
      const same = peers.filter((other) => other.providerID === row.providerID).map((other) => other.modelID)
      const suffix = same.length > 1 ? row.modelID.slice(sharedPrefix(same)).replace(/^[-_./:]+/, "") : ""

      return [row.key, { provider, model: suffix ? `${row.model} (${suffix})` : row.model }]
    }),
  )
}

// The part of the IDs they all share, cut back to a separator so "v1" and "v2" share nothing
// while "gemini-4-argon" and "gemini-4-argon-eap" share "gemini-4-argon".
function sharedPrefix(ids: string[]) {
  const first = ids[0] ?? ""
  const separator = (char: string | undefined) => !!char && /[-_./:]/.test(char)

  const boundary = (n: number) =>
    n === 0 || ids.every((id) => n === id.length || separator(id[n]) || separator(id[n - 1]))

  const differs = first.split("").findIndex((char, index) => ids.some((id) => id[index] !== char))
  const common = differs === -1 ? first.length : differs

  return Array.from({ length: common + 1 }, (_, index) => common - index).find(boundary) ?? 0
}
