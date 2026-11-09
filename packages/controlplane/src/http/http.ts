import type { IncomingMessage, ServerResponse } from "node:http"
import { Option, Schema } from "effect"

const BODY_LIMIT = 64 * 1024

export function send(
  res: ServerResponse,
  status: number,
  body?: unknown,
  headers: Record<string, string | string[]> = {},
) {
  if (body === undefined) {
    res.writeHead(status, headers)
    res.end()
    return
  }
  res.writeHead(status, { ...headers, "content-type": "application/json", "cache-control": "no-store" })
  res.end(JSON.stringify(body))
}

/** A JSON body decoder for `body()`, built once per schema. */
export function jsonDecoder<A>(schema: Schema.Codec<A, unknown>) {
  const decode = Schema.decodeUnknownOption(Schema.fromJsonString(schema))
  return (text: string) => Option.getOrUndefined(decode(text))
}

/** Reads a small JSON body and decodes it; undefined when it is missing, too large or the wrong shape. */
export async function body<A>(req: IncomingMessage, decode: (text: string) => A | undefined) {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length
    if (size > BODY_LIMIT) return undefined
    chunks.push(chunk)
  }
  return decode(Buffer.concat(chunks).toString("utf8"))
}

/** Reads a raw body of at most `limit` bytes; undefined when it is larger. */
export async function bytes(req: IncomingMessage, limit: number) {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length
    if (size > limit) return undefined
    chunks.push(chunk)
  }
  return new Uint8Array(Buffer.concat(chunks))
}

export function bearer(req: IncomingMessage) {
  return /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? "")?.[1]
}

export function cookies(req: IncomingMessage) {
  return Object.fromEntries(
    (req.headers.cookie ?? "")
      .split(";")
      .map((part) => part.trim().split("="))
      .filter((pair) => pair.length >= 2 && pair[0])
      .map((pair) => [pair[0]!, decodeURIComponent(pair.slice(1).join("="))]),
  )
}
