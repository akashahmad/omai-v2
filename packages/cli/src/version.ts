import { Option, Schema } from "effect"

declare const OMAI_VERSION: string
declare const OMAI_CHANNEL: string
declare const OMAI_ARTIFACT: string
declare const OMAI_RELEASE_HIGHLIGHTS: string

const version = typeof OMAI_VERSION === "string" ? OMAI_VERSION : "local"
const channel = typeof OMAI_CHANNEL === "string" ? OMAI_CHANNEL : "local"
const artifact = typeof OMAI_ARTIFACT === "string" ? OMAI_ARTIFACT : "cli"
// Stable release builds embed the release notes' Highlights; every other build has none.
const highlights =
  typeof OMAI_RELEASE_HIGHLIGHTS === "string"
    ? Option.getOrElse(
        Schema.decodeUnknownOption(
          Schema.fromJsonString(Schema.Array(Schema.Struct({ title: Schema.String, body: Schema.String }))),
        )(OMAI_RELEASE_HIGHLIGHTS),
        () => [],
      )
    : []

export {
  version as OMAI_VERSION,
  channel as OMAI_CHANNEL,
  artifact as OMAI_ARTIFACT,
  highlights as OMAI_HIGHLIGHTS,
}
export const OMAI_LOCAL = channel === "local"
