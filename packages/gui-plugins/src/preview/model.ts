import { Option, Schema } from "effect"

// The preview tab's pure pieces: where the preview lives, how the frame enters it, and what its pages report.

const LOG_LIMIT = 256 * 1024

/** The preview's origin: the hosted origin when there is one, else the server's host on the preview port. */
export function previewOrigin(serverURL: string, status: { port?: number; origin?: string }) {
  if (status.origin) return status.origin

  if (status.port === undefined) return undefined
  const url = new URL(serverURL)

  return `${url.protocol}//${url.hostname}:${status.port}`
}

/** The first page the frame loads: it tells the preview which origin may talk to it and trades the ticket. */
export function enterURL(origin: string, input: { parent: string; to: string; ticket?: string }) {
  const url = new URL("/__omai/enter", origin)
  url.searchParams.set("parent", input.parent)
  url.searchParams.set("to", input.to)

  if (input.ticket) url.searchParams.set("ticket", input.ticket)

  return url.href
}

export function appendLog(log: string, chunk: string) {
  return (log + chunk).slice(-LOG_LIMIT)
}

const LocationMessage = Schema.Struct({
  type: Schema.Literal("omai:location"),
  href: Schema.String,
  title: Schema.optional(Schema.String),
})

const decodeLocation = Schema.decodeUnknownOption(LocationMessage)

/** The page a preview message reports, when it is a location message from the preview itself. */
export function locationFrom(event: { origin: string; data: unknown }, origin: string) {
  if (event.origin !== origin) return undefined
  const message = Option.getOrUndefined(decodeLocation(event.data))
  const url = message && URL.parse(message.href)

  return url ? { path: url.pathname + url.search + url.hash, title: message.title ?? "" } : undefined
}

const PagesMessage = Schema.Struct({ type: Schema.Literal("omai:pages"), pages: Schema.Array(Schema.String) })

const decodePages = Schema.decodeUnknownOption(PagesMessage)

/** The pages a preview reports from its own links, when the message is from the preview itself. */
export function pagesFrom(event: { origin: string; data: unknown }, origin: string) {
  if (event.origin !== origin) return undefined

  return Option.getOrUndefined(decodePages(event.data))?.pages.slice()
}

const Health = Schema.Struct({ preview: Schema.Literal("omai"), up: Schema.Boolean })

const decodeHealth = Schema.decodeUnknownOption(Health)

/**
 * The preview's own answer to whether it is there, or undefined when something else answers: while a VM boots or
 * pauses, the load balancer in front of it answers with its own error page, which has neither this body nor the CORS
 * header the read needs.
 */
export async function previewHealth(
  origin: string,
  fetcher: (url: string, init: RequestInit) => Promise<Response> = (url, init) => fetch(url, init),
) {
  const body = await fetcher(new URL("/__omai/health", origin).href, {
    cache: "no-store",
    signal: AbortSignal.timeout(8_000),
  })
    .then((res) => (res.ok ? res.json() : undefined))
    .catch(() => undefined)

  const health = Option.getOrUndefined(decodeHealth(body))

  return health ? { up: health.up } : undefined
}

const decodeLeave = Schema.decodeUnknownOption(Schema.Struct({ type: Schema.Literal("omai:leave") }))

/** Whether a message from the frame says its page of the preview is leaving. */
export function leftFrom(event: { origin: string; data: unknown }, origin: string) {
  return event.origin === origin && Option.isSome(decodeLeave(event.data))
}
