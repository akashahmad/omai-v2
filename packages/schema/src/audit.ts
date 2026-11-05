export * as Audit from "./audit.js"

import { Schema } from "effect"
import { Rpc } from "./rpc.js"
import { optional } from "./schema.js"

/** The screen Lighthouse emulates. */
export const FormFactor = Schema.Literals(["mobile", "desktop"])
export type FormFactor = typeof FormFactor.Type

/** One Lighthouse audit that did not pass, in the language the audit ran in. */
export interface Finding extends Schema.Schema.Type<typeof Finding> {}
export const Finding = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  /** Lighthouse's own value for it, like "24.7 s" or "Est savings of 164 KiB"; empty when it has none. */
  display: Schema.String,
  /** From 0 to 1; null when the audit has no score. */
  score: Schema.NullOr(Schema.Number),
}).annotate({ identifier: "Audit.Finding" })

/** The five category scores, from 0 to 100; null when Lighthouse could not score one. */
export interface Categories extends Schema.Schema.Type<typeof Categories> {}
export const Categories = Schema.Struct({
  performance: Schema.NullOr(Schema.Number),
  accessibility: Schema.NullOr(Schema.Number),
  bestPractices: Schema.NullOr(Schema.Number),
  seo: Schema.NullOr(Schema.Number),
  agentic: Schema.NullOr(Schema.Number),
}).annotate({ identifier: "Audit.Categories" })

export type Category = keyof Categories

/** Lighthouse's lab metrics, as it displays them. */
export interface Metrics extends Schema.Schema.Type<typeof Metrics> {}
export const Metrics = Schema.Struct({
  fcp: Schema.NullOr(Schema.String),
  lcp: Schema.NullOr(Schema.String),
  tbt: Schema.NullOr(Schema.String),
  cls: Schema.NullOr(Schema.String),
  si: Schema.NullOr(Schema.String),
}).annotate({ identifier: "Audit.Metrics" })

export interface Lighthouse extends Schema.Schema.Type<typeof Lighthouse> {}
export const Lighthouse = Schema.Struct({
  /** The page Lighthouse ended on. */
  url: Schema.String,
  fetchTime: Schema.String,
  categories: Categories,
  metrics: Metrics,
  /** Failed audits, worst first. */
  failed: Schema.Array(Finding),
  /** How many of the Agentic Browsing checks passed; null when the category had none to run. */
  agentic: Schema.NullOr(Schema.Struct({ passed: Schema.Number, total: Schema.Number })),
}).annotate({ identifier: "Audit.Lighthouse" })

/** How much a check's finding matters. */
export const Severity = Schema.Literals(["critical", "high", "medium", "low", "optional", "info"])
export type Severity = typeof Severity.Type

/** Where a check's finding is listed. */
export const Group = Schema.Literals(["reachability", "geo", "agentic", "design", "technical"])
export type Group = typeof Group.Type

/**
 * A finding of O M A I +'s own checks. Clients name and explain it from `id` in their language; `values` fill the
 * copy's placeholders, like the broken links.
 */
export interface Check extends Schema.Schema.Type<typeof Check> {}
export const Check = Schema.Struct({
  id: Schema.String,
  group: Group,
  severity: Severity,
  values: optional(Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Number]))),
}).annotate({ identifier: "Audit.Check" })

/** What the page's own response says about the site. */
export interface Technical extends Schema.Schema.Type<typeof Technical> {}
export const Technical = Schema.Struct({
  /** The HTTP status of the page, after redirects. */
  status: Schema.Number,
  /** Milliseconds until the whole page arrived. */
  loadTime: Schema.Number,
  /** Milliseconds until the first byte arrived. */
  ttfb: Schema.Number,
  /** The page's size in bytes. */
  size: Schema.Number,
  https: Schema.Boolean,
  /** Days until the TLS certificate expires, for HTTPS sites. */
  certificateDays: optional(Schema.Number),
  server: optional(Schema.String),
  cms: optional(Schema.String),
  /** The country the domain's top-level domain names, like "CH"; absent for generic and local hosts. */
  country: optional(Schema.String),
  /** How many of the page's internal links were checked. */
  links: Schema.Number,
  /** The page's title, which the report suggests as the client's name. */
  title: optional(Schema.String),
}).annotate({ identifier: "Audit.Technical" })

export interface Report extends Schema.Schema.Type<typeof Report> {}
export const Report = Schema.Struct({
  id: Schema.String,
  /** The address the user asked for; the project's preview when `preview` is true. */
  url: Schema.String,
  preview: Schema.Boolean,
  formFactor: FormFactor,
  /** The language Lighthouse wrote its findings in. */
  locale: Schema.String,
  createdAt: Schema.Number,
  /** Archived reports are kept until removed; the rest go once newer ones replace them. */
  archived: Schema.Boolean,
  /** The overall score from 0 to 100: Lighthouse's categories and the own checks together. */
  score: Schema.Number,
  lighthouse: optional(Lighthouse),
  /** Why Lighthouse gave no result, when it gave none. */
  lighthouseError: optional(Schema.String),
  technical: optional(Technical),
  /** Why the page could not be fetched, when it could not. */
  technicalError: optional(Schema.String),
  checks: Schema.Array(Check),
}).annotate({ identifier: "Audit.Report" })

/** A report as the history lists it. */
export interface Summary extends Schema.Schema.Type<typeof Summary> {}
export const Summary = Schema.Struct({
  id: Schema.String,
  url: Schema.String,
  preview: Schema.Boolean,
  formFactor: FormFactor,
  createdAt: Schema.Number,
  archived: Schema.Boolean,
  score: Schema.Number,
}).annotate({ identifier: "Audit.Summary" })

export interface Status extends Schema.Schema.Type<typeof Status> {}
export const Status = Schema.Struct({
  /** The project directory, so clients can tell projects apart in the event stream. */
  directory: optional(Schema.String),
  /** The audit in progress. */
  running: optional(
    Schema.Struct({
      url: Schema.String,
      preview: Schema.Boolean,
      formFactor: FormFactor,
      startedAt: Schema.Number,
      /** What it is doing now. */
      step: Schema.Literals(["preview", "lighthouse", "scan"]),
    }),
  ),
  /** The newest report. */
  latest: optional(Report),
  /** Why the last audit failed, when it failed before it made a report. */
  error: optional(Schema.String),
  /** Every kept report, newest first. */
  history: Schema.Array(Summary),
}).annotate({ identifier: "Audit.Status" })

const standard = Schema.toStandardSchemaV1
const Empty = Schema.Struct({})
const ByID = Schema.Struct({ id: Schema.String })
/** A call that could not do its work; `message` says why in one plain sentence. */
const errors = { "audit.failed": standard(Empty) }

/**
 * The website audit's RPC, served in the project's Location: Lighthouse plus O M A I +'s own checks, for the project's
 * preview or any address. `run` returns at once; follow `changed` for the report.
 */
export const Definition = Rpc.define({
  id: "omai.audit",
  methods: {
    status: { input: standard(Empty), output: standard(Status) },
    run: {
      input: standard(
        Schema.Struct({
          /** The address to audit; the project's preview when absent. */
          url: optional(Schema.String),
          formFactor: FormFactor,
          /** The language for Lighthouse's findings, like "de". English when absent or unsupported. */
          locale: optional(Schema.String),
        }),
      ),
      output: standard(Status),
      errors,
    },
    cancel: { input: standard(Empty), output: standard(Status) },
    open: { input: standard(ByID), output: standard(Report), errors },
    archive: { input: standard(Schema.Struct({ id: Schema.String, archived: Schema.Boolean })), output: standard(Status) },
    remove: { input: standard(ByID), output: standard(Status) },
    /** Prints a report page the client wrote to PDF, in its language. */
    pdf: {
      input: standard(Schema.Struct({ html: Schema.String })),
      output: standard(Schema.Struct({ base64: Schema.String })),
      errors,
    },
  },
  events: {
    changed: { schema: standard(Status) },
  },
})
