export * as Publish from "./publish.js"

import { Schema } from "effect"
import { Rpc } from "./rpc.js"
import { optional } from "./schema.js"

export const Kind = Schema.Literals([
  "static",
  "spa",
  "pages",
  "next",
  "nuxt",
  "solidstart",
  "sveltekit",
  "astro-server",
  "react-router",
])
export type Kind = typeof Kind.Type

export const Stage = Schema.Literals(["prepare", "install", "build", "upload"])
export type Stage = typeof Stage.Type

export const DeployStatus = Schema.Literals(["running", "live", "failed", "cancelled"])
export type DeployStatus = typeof DeployStatus.Type

export interface Deploy extends Schema.Schema.Type<typeof Deploy> {}
export const Deploy = Schema.Struct({
  id: Schema.String,
  status: DeployStatus,
  stage: optional(Stage),
  kind: optional(Kind),
  error: optional(Schema.String),
  /** Start time in milliseconds. */
  startedAt: Schema.Number,
  finishedAt: optional(Schema.Number),
  stages: Schema.Array(
    Schema.Struct({ stage: Stage, startedAt: Schema.Number, finishedAt: optional(Schema.Number) }),
  ),
}).annotate({ identifier: "Publish.Deploy" })

export interface Site extends Schema.Schema.Type<typeof Site> {}
export const Site = Schema.Struct({
  name: Schema.String,
  url: Schema.String,
  zone: Schema.String,
  kind: optional(Kind),
  publishedAt: optional(Schema.Number),
  /** The custom hostname that visitors are sent to, when one is set as primary. */
  primary: optional(Schema.String),
}).annotate({ identifier: "Publish.Site" })

export interface Status extends Schema.Schema.Type<typeof Status> {}
export const Status = Schema.Struct({
  configured: Schema.Boolean,
  /** The platform zone sites are published under, such as `omai.ch`; set whenever publishing is configured. */
  zone: optional(Schema.String),
  site: optional(Site),
  running: optional(Deploy),
  history: Schema.Array(Deploy),
  detected: optional(
    Schema.Struct({ kind: optional(Kind), framework: optional(Schema.String), reason: optional(Schema.String) }),
  ),
}).annotate({ identifier: "Publish.Status" })

export const DomainStatus = Schema.Literals(["pending", "active", "error"])
export type DomainStatus = typeof DomainStatus.Type

export interface DnsRecord extends Schema.Schema.Type<typeof DnsRecord> {}
export const DnsRecord = Schema.Struct({
  type: Schema.Literals(["CNAME", "A", "ALIAS", "TXT"]),
  name: Schema.String,
  value: Schema.String,
  /** Whether the record was seen in DNS. */
  ok: optional(Schema.Boolean),
}).annotate({ identifier: "Publish.DnsRecord" })

export interface Domain extends Schema.Schema.Type<typeof Domain> {}
export const Domain = Schema.Struct({
  hostname: Schema.String,
  primary: Schema.Boolean,
  status: DomainStatus,
  ssl: Schema.String,
  apex: Schema.Boolean,
  records: Schema.Array(DnsRecord),
  verification: optional(DnsRecord),
  error: optional(Schema.String),
}).annotate({ identifier: "Publish.Domain" })

export interface Domains extends Schema.Schema.Type<typeof Domains> {}
export const Domains = Schema.Struct({
  configured: Schema.Boolean,
  site: optional(Site),
  subdomain: optional(Schema.Struct({ host: Schema.String, redirects: Schema.Boolean })),
  domains: Schema.Array(Domain),
}).annotate({ identifier: "Publish.Domains" })

export const FailureKind = Schema.Literals([
  "not-configured",
  "not-published",
  "invalid",
  "taken",
  "limit",
  "cloudflare",
  "unsupported",
  "busy",
  "other",
])
export type FailureKind = typeof FailureKind.Type

const standard = Schema.toStandardSchemaV1
const Empty = Schema.Struct({})
const Hostname = Schema.Struct({ hostname: Schema.String })

const errors = {
  "publish.failed": standard(Schema.Struct({ kind: FailureKind, message: Schema.String })),
}

/** The Publish tool's RPC, served in the project's Location. Every method can fail with `publish.failed`. */
export const Definition = Rpc.define({
  id: "omai.publish",
  methods: {
    status: { input: standard(Empty), output: standard(Status), errors },
    available: {
      input: standard(Schema.Struct({ name: Schema.String })),
      output: standard(Schema.Struct({ available: Schema.Boolean, reason: optional(Schema.String) })),
      errors,
    },
    publish: {
      input: standard(Schema.Struct({ name: optional(Schema.String), sessionID: optional(Schema.String) })),
      output: standard(Deploy),
      errors,
    },
    cancel: { input: standard(Empty), output: standard(Empty), errors },
    log: {
      input: standard(Schema.Struct({ id: Schema.String })),
      output: standard(Schema.Struct({ text: Schema.String })),
      errors,
    },
    remove: { input: standard(Schema.Struct({ confirm: Schema.String })), output: standard(Empty), errors },
  },
  events: {
    changed: { schema: standard(Status) },
    log: { schema: standard(Schema.Struct({ id: Schema.String, chunk: Schema.String })) },
  },
})

/** The custom domains RPC, served in the project's Location. Every method can fail with `publish.failed`. */
export const DomainsDefinition = Rpc.define({
  id: "omai.domains",
  methods: {
    list: { input: standard(Empty), output: standard(Domains), errors },
    add: {
      input: standard(Schema.Struct({ hostname: Schema.String, primary: optional(Schema.Boolean) })),
      output: standard(Domains),
      errors,
    },
    remove: { input: standard(Hostname), output: standard(Domains), errors },
    setPrimary: { input: standard(Hostname), output: standard(Domains), errors },
    check: {
      input: standard(Schema.Struct({ hostname: optional(Schema.String) })),
      output: standard(Domains),
      errors,
    },
  },
  events: {
    changed: { schema: standard(Domains) },
  },
})
