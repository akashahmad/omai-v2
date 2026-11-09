export * as PublishDns from "./dns.js"

import { Resolver } from "node:dns/promises"
import type { Publish } from "@opencode/schema/publish"
import { PublishConfig } from "./config.js"
import { isApex } from "./name.js"

export type Resolved = { cname: string[]; a: string[]; txt?: string[] }
/** Looks up a host's CNAME, A and TXT records; a failed lookup answers empty lists. */
export type Resolve = (host: string) => Promise<Resolved>

/** The records each domain needs, in order, read from DNS in parallel. */
export async function recordsOf(
  resolve: Resolve,
  config: PublishConfig.Config,
  domains: readonly { hostname: string; ownership?: { name: string; value: string } }[],
) {
  const target = await resolve(PublishConfig.target(config.zone))
  return Promise.all(
    domains.map(async (domain) => {
      const ownership = domain.ownership
      const proof = ownership && { ...ownership, seen: (await resolve(ownership.name)).txt ?? [] }
      return records(domain.hostname, config, await resolve(domain.hostname), target, proof)
    }),
  )
}

/**
 * The DNS records a domain needs, each marked with whether DNS already shows it. A root domain behind an ALIAS or
 * flattened record resolves to addresses only, so Cloudflare can't see that it points here and verifies it by the
 * ownership TXT record instead, which is then required too.
 */
export function records(
  host: string,
  config: PublishConfig.Config,
  seen: Resolved,
  target: Resolved,
  ownership?: { name: string; value: string; seen: string[] },
) {
  const value = PublishConfig.target(config.zone)
  if (!isApex(host))
    return [
      { type: "CNAME", name: host, value, ok: seen.cname.some((name) => sameHost(name, value)) },
    ] satisfies Publish.DnsRecord[]
  if (config.apexIPs.length > 0)
    return config.apexIPs.map((ip) => ({
      type: "A",
      name: host,
      value: ip,
      ok: seen.a.includes(ip),
    })) satisfies Publish.DnsRecord[]
  // A flattened record shows up as the target's addresses rather than as a CNAME.
  const ok = seen.cname.some((name) => sameHost(name, value)) || seen.a.some((ip) => target.a.includes(ip))
  return [
    { type: "ALIAS", name: host, value, ok },
    ...(ownership
      ? [{ type: "TXT" as const, name: ownership.name, value: ownership.value, ok: ownership.seen.includes(ownership.value) }]
      : []),
  ] satisfies Publish.DnsRecord[]
}

// One quick try: a slow name server must not hold up every view.
const resolver = new Resolver({ timeout: 2_000, tries: 1 })

export async function lookup(host: string): Promise<Resolved> {
  const found = await Promise.all([
    resolver.resolveCname(host).catch(() => []),
    resolver.resolve4(host).catch(() => []),
    resolver.resolveTxt(host).catch(() => []),
  ])
  return { cname: found[0], a: found[1], txt: found[2].map((chunks) => chunks.join("")) }
}

function sameHost(a: string, b: string) {
  return a.toLowerCase().replace(/\.$/, "") === b.toLowerCase().replace(/\.$/, "")
}
