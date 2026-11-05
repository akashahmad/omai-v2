// What the Publishing panel derives from the server's status: each step of a run, how long a deploy took, the address
// visitors use, and the prompt that asks the agent to fix a failed deploy.

import type { Publish } from "@opencode/schema/publish"

export type Translate = (key: string, params?: Record<string, string | number>) => string

/** The stepper's steps: the pipeline's stages, then the site going live. */
export const STEPS = ["prepare", "install", "build", "upload", "live"] as const

export type Step = (typeof STEPS)[number]

export type StepState = "done" | "active" | "todo" | "failed"

/** The last part of a deploy's log the agent sees when asked to fix it. */
const LOG_TAIL = 4096

const NAME_MAX = 40

/**
 * Where a step of a deploy stands. A live deploy is done at every step, the ones its kind skips included. Otherwise the
 * steps before the stage it reached are done, that stage is active while it runs and failed when it failed, and the
 * rest are still to come; a cancelled run stopped there, so that stage counts as not reached.
 */
export function stepState(deploy: Publish.Deploy, step: Step): StepState {
  if (deploy.status === "live") return "done"

  const reached = STEPS.indexOf(deploy.stage ?? "prepare")
  const index = STEPS.indexOf(step)

  if (index < reached) return "done"

  if (index > reached) return "todo"

  if (deploy.status === "running") return "active"

  return deploy.status === "failed" ? "failed" : "todo"
}

/** How long a deploy took, or has taken so far while it runs, as a clock: `0:45`, `1:23`, `1:02:03`. */
export function duration(deploy: Publish.Deploy, now = Date.now()) {
  const seconds = Math.max(0, Math.round(((deploy.finishedAt ?? now) - deploy.startedAt) / 1000))
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const rest = String(seconds % 60).padStart(2, "0")

  if (hours > 0) return `${hours}:${String(minutes).padStart(2, "0")}:${rest}`

  return `${minutes}:${rest}`
}

/**
 * The address visitors use: the primary domain once it is active, else the platform subdomain, which serves the site
 * while the primary waits for DNS.
 */
/** The site's primary custom domain, when one is set and listed; it serves visitors only once it is active. */
export function primaryDomain(site: Publish.Site, domains: readonly Publish.Domain[]) {
  return site.primary ? domains.find((domain) => domain.primary && domain.hostname === site.primary) : undefined
}

export function liveAddress(site: Publish.Site, domains: readonly Publish.Domain[]) {
  const primary = primaryDomain(site, domains)

  if (primary?.status === "active") return `https://${primary.hostname}`

  return `https://${site.name}.${site.zone}`
}

/** A project name as a site name, as the server suggests it: lowercase letters, numbers and hyphens, at most 40. */
export function slug(input: string) {
  return (
    input
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, NAME_MAX)
      .replace(/-+$/g, "") || "site"
  )
}

/** How long ago a time was, in the user's language: "5 minutes ago", "yesterday". `time` is in milliseconds. */
export function ago(time: number, now: number, locale: string) {
  const format = new Intl.RelativeTimeFormat(locale, { numeric: "auto" })
  const seconds = Math.round((time - now) / 1000)

  const units = [
    { unit: "day", seconds: 86_400 },
    { unit: "hour", seconds: 3_600 },
    { unit: "minute", seconds: 60 },
  ] as const

  const match = units.find((item) => Math.abs(seconds) >= item.seconds)

  if (!match) return format.format(0, "minute")

  return format.format(Math.round(seconds / match.seconds), match.unit)
}

/** The request "Ask AI to fix" sends: why the deploy failed, the step it failed at, and the end of its log. */
export function fixPrompt(deploy: Publish.Deploy, log: string) {
  return [
    `Publishing this project failed${deploy.stage ? ` at the ${deploy.stage} step` : ""}: ${deploy.error ?? "no reason was given"}.`,
    "Find the cause in the project and fix it so the next publish succeeds. The project is built in a copy of this directory with its package manager and `build` script, then uploaded to Cloudflare Workers.",
    "",
    "The end of the deploy log:",
    "",
    "```text",
    log.slice(-LOG_TAIL),
    "```",
  ].join("\n")
}
