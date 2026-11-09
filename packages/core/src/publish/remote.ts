export * as PublishRemote from "./remote.js"

import { createReadStream } from "node:fs"
import { Readable } from "node:stream"
import { Schema } from "effect"
import { Publish } from "@opencode/schema/publish"

/**
 * How long a deploy may take on the control plane: a first install of wrangler there (up to 10 minutes), the wait for
 * a free upload slot (up to 2) and the upload (up to 5), with room to spare.
 */
export const DEPLOY_TIMEOUT = 1_200_000
const TIMEOUT = 30_000
const UNREACHABLE = "Couldn't reach O M A I +. Try again in a moment."
const SLOW = "O M A I + took too long to answer. Try again in a moment."

export type Target = { url: string; projectID: string; token: string }

/** A publishing request the control plane refused or could not answer; `message` is shown as is. */
export class RemoteError extends Error {
  constructor(
    readonly kind: Publish.FailureKind,
    message: string,
    readonly log?: string,
  ) {
    super(message)
    this.name = "RemoteError"
  }
}

/** On a project's MicroVM, the control plane that does its publishing; undefined in single-user mode. */
export function target(env: Record<string, string | undefined>): Target | undefined {
  const url = env.OMAI_CONTROL_PLANE_URL
  const projectID = env.OMAI_PROJECT_ID
  const token = env.OMAI_PROJECT_TOKEN
  if (!url || !projectID || !token || projectID === "platform") return undefined
  return { url: url.replace(/\/+$/, ""), projectID, token }
}

export type Site = { name: string; url: string; zone: string; kind?: Publish.Kind; publishedAt?: number; primary?: string }

/** The control plane's publishing routes for this VM's project. Every call rejects with `RemoteError`. */
export function client(target: Target, options: { timeoutMs?: number } = {}) {
  const base = `${target.url}/internal/projects/${encodeURIComponent(target.projectID)}`
  const call = async <A>(
    method: string,
    route: string,
    input: { json?: unknown; body?: Readable; signal?: AbortSignal } = {},
  ): Promise<A> => {
    const timeout = AbortSignal.timeout(options.timeoutMs ?? (input.body ? DEPLOY_TIMEOUT : TIMEOUT))
    const response = await fetch(base + route, {
      method,
      headers: {
        authorization: `Bearer ${target.token}`,
        ...(input.json !== undefined ? { "content-type": "application/json" } : {}),
        ...(input.body ? { "content-type": "application/zip" } : {}),
      },
      // Streamed, so a large site isn't held in memory. Node's web stream type differs from the DOM one fetch names.
      body: input.body
        ? (Readable.toWeb(input.body) as unknown as BodyInit)
        : input.json !== undefined
          ? JSON.stringify(input.json)
          : undefined,
      signal: input.signal ? AbortSignal.any([input.signal, timeout]) : timeout,
      ...(input.body ? { duplex: "half" } : {}),
    }).catch((error: unknown) => {
      if (input.signal?.aborted) throw new RemoteError("other", "The publish was cancelled.")
      if (timeout.aborted) throw new RemoteError("other", SLOW)
      throw new RemoteError("other", UNREACHABLE, error instanceof Error ? error.message : undefined)
    })
    const text = await response.text().catch(() => "")
    if (response.ok) return (text ? JSON.parse(text) : undefined) as A
    const refused = decodeRefusal(text)
    if (refused._tag === "Some") throw new RemoteError(refused.value.kind, refused.value.message, refused.value.log)
    throw new RemoteError("other", UNREACHABLE)
  }

  return {
    status: () => call<{ configured: boolean; zone?: string; site?: Site }>("GET", "/publish"),
    available: (name: string) => call<{ available: boolean; reason?: string }>("POST", "/publish/available", { json: { name } }),
    claim: (name: string) => call<Site>("POST", "/publish/claim", { json: { name } }),
    release: () => call<void>("POST", "/publish/release"),
    remove: (confirm: string) => call<void>("DELETE", "/publish", { json: { confirm } }),
    /** Uploads the packed bundle; resolves with wrangler's log once the site is live. */
    deploy: (zip: string, input: { kind: Publish.Kind; entry?: string }, signal: AbortSignal) =>
      call<{ log: string }>(
        "POST",
        `/publish/deploy?${new URLSearchParams({ kind: input.kind, ...(input.entry ? { entry: input.entry } : {}) })}`,
        { body: createReadStream(zip), signal },
      ),
    domains: {
      list: () => call<Publish.Domains>("GET", "/domains"),
      add: (hostname: string, primary?: boolean) =>
        call<Publish.Domains>("POST", "/domains", { json: { hostname, ...(primary ? { primary } : {}) } }),
      remove: (hostname: string) => call<Publish.Domains>("DELETE", `/domains/${encodeURIComponent(hostname)}`),
      setPrimary: (hostname: string) =>
        call<Publish.Domains>("POST", `/domains/${encodeURIComponent(hostname)}/primary`),
      check: (hostname?: string) =>
        call<Publish.Domains>("POST", "/domains/check", { json: hostname ? { hostname } : {} }),
    },
  }
}

export type Client = ReturnType<typeof client>

const decodeRefusal = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({ kind: Publish.FailureKind, message: Schema.String, log: Schema.optional(Schema.String) }),
  ),
)
