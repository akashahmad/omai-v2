// What the Domains panel derives from the server's domains: the status pill each domain shows, the order of the cards,
// and the www suggestion offered when the user types an apex domain.

import type { Publish } from "@opencode/schema/publish"

/** The domains a site can have; the server refuses more. */
export const LIMIT = 10

/** How often the panel asks the server to check pending domains again while it is on screen. */
export const RECHECK = 30_000

export type Pill = "active" | "dns" | "certificate" | "error"

// Mirrors core's `PublishName.isApex` list (gui-plugins never imports core): a heuristic, not the public suffix list.
const TWO_PART_SUFFIXES: ReadonlySet<string> = new Set([
  "co.uk",
  "com.au",
  "co.nz",
  "com.br",
  "co.jp",
  "co.in",
  "org.uk",
  "ac.uk",
  "edu.au",
  "com.pk",
  "edu.pk",
])

const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/

/**
 * The status pill of a domain. Before it is active, a record DNS does not show yet means it waits for DNS; once every
 * record is in place it waits for Cloudflare to issue its certificate.
 */
export function pill(domain: Publish.Domain): Pill {
  if (domain.status === "active") return "active"

  if (domain.status === "error") return "error"

  if (domain.records.some((record) => record.ok === false)) return "dns"

  return "certificate"
}

/** The primary domain first, then the rest by hostname. */
export function sortDomains(domains: readonly Publish.Domain[]) {
  return domains.toSorted((a, b) => Number(b.primary) - Number(a.primary) || a.hostname.localeCompare(b.hostname))
}

/** What the user typed as the server reads it: lowercase, without the scheme, path, port and trailing dot. */
export function normalizeHostname(input: string) {
  return input
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
    .replace(/[/?#].*$/, "")
    .replace(/:\d+$/, "")
    .replace(/\.$/, "")
    .trim()
}

/** For an apex domain such as `xyz.edu`, the www host to offer as the primary beside it; nothing for a subdomain. */
export function suggestion(input: string) {
  const apex = normalizeHostname(input)
  const labels = apex.split(".")

  if (labels.length < 2 || !labels.every((label) => LABEL.test(label))) return undefined

  if (labels.length === 2 || (labels.length === 3 && TWO_PART_SUFFIXES.has(labels.slice(1).join("."))))
    return { apex, www: `www.${apex}` }

  return undefined
}
