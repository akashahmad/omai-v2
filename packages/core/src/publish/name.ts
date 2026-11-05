export * as PublishName from "./name.js"

export const RESERVED: ReadonlySet<string> = new Set([
  "app",
  "preview",
  "view",
  "www",
  "live",
  "web",
  "autoconfig",
  "autodiscover",
  "fallback",
  "dispatch",
  "omai-dispatcher",
  "domains",
])

const MAX = 40
const NAME = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/
const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/

// A heuristic, not the public suffix list: only the two-part suffixes customers are likely to bring.
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

export function slug(input: string) {
  return (
    input
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, MAX)
      .replace(/-+$/g, "") || "site"
  )
}

/** The error copy for an unusable app name, or undefined when the name is fine. */
export function validName(name: string): string | undefined {
  if (!NAME.test(name))
    return "Use 1-40 lowercase letters, numbers or hyphens, starting and ending with a letter or number."
  if (RESERVED.has(name)) return `"${name}" is reserved. Choose another name.`
  return undefined
}

/** Lowercases and strips the scheme, path, port and trailing dot. */
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

/** Lowercase hostname with at least two labels; each label is 1-63 chars of [a-z0-9-] without edge hyphens. */
export function isHostname(host: string) {
  return host.length <= 253 && host.includes(".") && host.split(".").every((label) => LABEL.test(label))
}

/** True for two labels, or three when the last two are a known two-part public suffix. */
export function isApex(host: string) {
  const labels = host.split(".")
  if (labels.length === 2) return true
  return labels.length === 3 && TWO_PART_SUFFIXES.has(labels.slice(1).join("."))
}

export const wwwOf = (apex: string) => `www.${apex}`
