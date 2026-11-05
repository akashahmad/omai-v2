// The window's side of the visual editor protocol (v1). The editor runs inside the preview page (core
// preview/visual.ts) and posts these messages; the window decodes every one before trusting it, and only from the
// preview frame itself.

import { Option, Schema } from "effect"

// Optional fields accept `undefined` as well as absence: structured clone keeps properties set to undefined.
const Text = (max: number) => Schema.String.check(Schema.isMaxLength(max))

const Fingerprint = Schema.Struct({
  tag: Text(32),
  id: Schema.optional(Text(256)),
  classes: Schema.Array(Text(256)).check(Schema.isMaxLength(20)),
  text: Schema.optional(Text(120)),
  attrs: Schema.Record(Schema.String, Text(512)),
  index: Schema.Number,
})

export type Fingerprint = typeof Fingerprint.Type

const SourceHint = Schema.Struct({
  file: Schema.optional(Text(1024)),
  line: Schema.optional(Schema.Number),
  column: Schema.optional(Schema.Number),
  component: Schema.optional(Text(256)),
})

export type SourceHint = typeof SourceHint.Type

const Crumb = Schema.Struct({ label: Text(64), path: Text(2048) })

const ElementInfo = Schema.Struct({
  path: Text(2048),
  fingerprint: Fingerprint,
  label: Text(64),
  tag: Text(32),
  text: Schema.optional(Text(2000)),
  rect: Schema.Struct({ x: Schema.Number, y: Schema.Number, width: Schema.Number, height: Schema.Number }),
  styles: Schema.Record(Schema.String, Text(2048)),
  isText: Schema.Boolean,
  /** The element holds only text, so the inspector can edit it; mixed markup is edited in place. */
  plainText: Schema.Boolean,
  isImage: Schema.Boolean,
  src: Schema.optional(Text(8 * 1024 * 1024)),
  /** The image's resolved address in the page, for showing it in the window. */
  srcUrl: Schema.optional(Text(8 * 1024 * 1024)),
  alt: Schema.optional(Text(2048)),
  href: Schema.optional(Text(8192)),
  layout: Schema.Literals(["block", "flex", "grid", "inline"]),
  breadcrumb: Schema.Array(Crumb),
  source: Schema.optional(SourceHint),
})

export type ElementInfo = typeof ElementInfo.Type

const LiveChange = Schema.Struct({
  path: Text(2048),
  fingerprint: Fingerprint,
  kind: Schema.Literals(["style", "text", "attribute", "move"]),
  property: Schema.optional(Text(64)),
  before: Text(65536),
  after: Text(8 * 1024 * 1024),
  /** The element's markup after an inline text edit, so a reload re-applies it without flattening child elements. */
  html: Schema.optional(Text(65536)),
})

export type LiveChange = typeof LiveChange.Type

const Version = Schema.Literal(1)

const Message = Schema.Union([
  Schema.Struct({ type: Schema.Literal("omai:visual:loaded"), v: Version }),
  Schema.Struct({ type: Schema.Literal("omai:visual:ready"), v: Version, fonts: Schema.Array(Text(256)), colors: Schema.Array(Text(64)) }),
  Schema.Struct({ type: Schema.Literal("omai:visual:select"), v: Version, element: Schema.NullOr(ElementInfo) }),
  Schema.Struct({ type: Schema.Literal("omai:visual:change"), v: Version, change: LiveChange }),
  Schema.Struct({ type: Schema.Literal("omai:visual:ask"), v: Version, element: ElementInfo }),
  Schema.Struct({ type: Schema.Literal("omai:visual:image"), v: Version, element: ElementInfo }),
  Schema.Struct({ type: Schema.Literal("omai:visual:error"), v: Version, message: Text(1024) }),
])

export type VisualMessage = typeof Message.Type

const decode = Schema.decodeUnknownOption(Message)

/** A visual editor message, when it comes from the preview frame at `origin` and decodes. */
export function visualMessage(
  event: { origin: string; source: MessageEventSource | null; data: unknown },
  origin: string,
  frame: Window | null | undefined,
): VisualMessage | undefined {
  if (event.origin !== origin || !frame || event.source !== frame) return undefined

  return Option.getOrUndefined(decode(event.data))
}

/** What the window can ask the editor in the page to do. */
export type Command =
  | { name: "enable"; labels?: Record<string, string> }
  | { name: "disable" }
  | { name: "select"; path: string }
  | { name: "parent" }
  | { name: "style"; property: string; value: string }
  | { name: "text"; value: string }
  | { name: "attribute"; attr: "src" | "alt" | "href" | "title"; value: string }
  | { name: "move"; delta: -1 | 1 }
  | { name: "apply"; changes: readonly LiveChange[] }
  | { name: "revert"; change: LiveChange }

/** One command as the editor in the page expects it. */
export const command = (value: Command) => ({ type: "omai:visual:command" as const, v: 1 as const, command: value })

/** Everything the window posts to the preview page for visual editing: a command, or asking the bridge to load it. */
export type PageMessage = ReturnType<typeof command> | { type: "omai:visual"; action: "load" }
