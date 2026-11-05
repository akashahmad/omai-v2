export * as PublishRouting from "./routing.js"

import { RESERVED } from "./name.js"

export type Route = { script: string } | { redirect: string }

type Domain = { hostname: string; primary: boolean; status: string }

export function routes(input: { name: string; zone: string; domains: Domain[] }) {
  const map = new Map<string, Route>()
  const primary = input.domains.find((domain) => domain.primary)
  if (!primary) {
    input.domains.forEach((domain) => map.set(domain.hostname, { script: input.name }))
    return map
  }
  const active = primary.status === "active"
  input.domains.forEach((domain) =>
    map.set(domain.hostname, domain.primary || !active ? { script: input.name } : { redirect: primary.hostname }),
  )
  if (active) map.set(`${input.name}.${input.zone}`, { redirect: primary.hostname })
  return map
}

/** Only hosts in `current` or `next` are touched, so keys owned by other projects are never removed. */
export function diff(current: Map<string, Route>, next: Map<string, Route>) {
  return {
    put: [...next].filter(([host, route]) => serialize(current.get(host)) !== serialize(route)),
    remove: [...current.keys()].filter((host) => !next.has(host)),
  }
}

export function serialize(route: Route | undefined) {
  return route ? JSON.stringify(route) : ""
}

/** Reads JSON route objects; any other value is the legacy plain-string script name. */
export function parseValue(raw: string): Route | undefined {
  if (!raw.startsWith("{")) return raw ? { script: raw } : undefined
  const parsed = parseObject(raw)
  if (typeof parsed?.redirect === "string" && parsed.redirect) return { redirect: parsed.redirect }
  if (typeof parsed?.script === "string" && parsed.script) return { script: parsed.script }
  return undefined
}

function parseObject(raw: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(raw)
    return typeof value === "object" && value ? (value as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

/** The platform subdomain label that names a script, or undefined when reserved or nested. */
export function resolveScript(host: string, zone: string) {
  const suffix = `.${zone.toLowerCase()}`
  const name = host.toLowerCase()
  if (!name.endsWith(suffix)) return undefined
  const label = name.slice(0, -suffix.length)
  if (!label || label.includes(".") || RESERVED.has(label)) return undefined
  return label
}
