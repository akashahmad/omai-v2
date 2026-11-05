// One project's website audits: the audit in progress, the newest report and the kept history. An audit runs in the
// background and reports through `changed`, so it outlives the panel that started it.

import { randomBytes } from "node:crypto"
import type { Audit } from "@opencode/schema/audit"
import { findChrome } from "./chrome.js"
import { lighthouseLocale, runLighthouse } from "./lighthouse.js"
import { printPdf } from "./pdf.js"
import { overallScore, scanSite } from "./scan.js"

/** Reports kept besides the archived ones. */
const KEEP = 10

const HISTORY_KEY = "audit.history"

export interface AuditorInput {
  directory: string
  store: { get(key: string): Promise<unknown>; set(key: string, value: unknown): Promise<void> }
  /** Starts the project's preview when it is not running and returns its dev server's address. */
  preview(): Promise<string>
  emit(status: Audit.Status): void
}

export type Auditor = ReturnType<typeof createAuditor>

export function createAuditor(input: AuditorInput) {
  const state: {
    running?: NonNullable<Audit.Status["running"]>
    abort?: AbortController
    error?: string
    history?: Audit.Report[]
  } = {}

  const history = async () => {
    if (state.history) return state.history
    const stored = await input.store.get(HISTORY_KEY)
    // SAFETY: only this module writes the key, always as an array of reports.
    state.history = Array.isArray(stored) ? (stored as Audit.Report[]) : []

    return state.history
  }

  const status = async (): Promise<Audit.Status> => {
    const reports = await history()

    return {
      directory: input.directory,
      running: state.running,
      latest: reports[0],
      error: state.error,
      history: reports.map((report) => ({
        id: report.id,
        url: report.url,
        preview: report.preview,
        formFactor: report.formFactor,
        createdAt: report.createdAt,
        archived: report.archived,
        score: report.score,
      })),
    }
  }

  const changed = async () => {
    const next = await status()
    input.emit(next)

    return next
  }

  const save = async (reports: Audit.Report[]) => {
    // The newest reports and every archived one stay; the rest go.
    const kept = reports.filter((report, index) => report.archived || index < KEEP)
    state.history = kept
    await input.store.set(HISTORY_KEY, kept)
  }

  const step = (next: NonNullable<Audit.Status["running"]>["step"]) => {
    if (!state.running) return
    state.running = { ...state.running, step: next }
    void changed()
  }

  const audit = async (request: { url?: string; formFactor: Audit.FormFactor; locale?: string }, signal: AbortSignal) => {
    const chrome = findChrome()
    const preview = !request.url
    const url = request.url ?? (await input.preview())

    if (signal.aborted) return
    step("lighthouse")
    const locale = lighthouseLocale(request.locale)
    const lighthouse = chrome
      ? await runLighthouse({ url, formFactor: request.formFactor, locale, chrome, cwd: input.directory, signal }).then(
          (value) => ({ value }),
          (error: unknown) => ({ error: message(error) }),
        )
      : { error: "Google Chrome is needed for Lighthouse. Install it, or set CHROME_PATH." }

    if (signal.aborted) return
    step("scan")
    const scan = await scanSite({ url, local: preview, signal }).then(
      (value) => ({ value }),
      (error: unknown) => ({ error: message(error) }),
    )

    if (signal.aborted) return
    const lighthouseValue = "value" in lighthouse ? lighthouse.value : undefined
    const checks = "value" in scan ? scan.value.checks : []

    if (!lighthouseValue && !("value" in scan)) throw new Error(scan.error)
    const report: Audit.Report = {
      id: `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`,
      url: request.url ?? lighthouseValue?.url ?? url,
      preview,
      formFactor: request.formFactor,
      locale,
      createdAt: Date.now(),
      archived: false,
      score: overallScore(lighthouseValue, checks),
      lighthouse: lighthouseValue,
      lighthouseError: "error" in lighthouse ? lighthouse.error : undefined,
      technical: "value" in scan ? scan.value.technical : undefined,
      technicalError: "error" in scan ? scan.error : undefined,
      checks,
    }
    await save([report, ...(await history())])
  }

  return {
    status,
    run: async (options: { url?: string; formFactor: Audit.FormFactor; locale?: string }) => {
      if (state.running) return status()
      // A bad address fails the call itself rather than becoming an audit that fails.
      const request = { ...options, url: options.url?.trim() ? normalize(options.url) : undefined }
      const abort = new AbortController()
      state.abort = abort
      state.error = undefined
      state.running = {
        url: request.url ?? "",
        preview: !request.url,
        formFactor: request.formFactor,
        startedAt: Date.now(),
        step: request.url ? "lighthouse" : "preview",
      }
      void audit(request, abort.signal)
        .catch((error: unknown) => {
          if (!abort.signal.aborted) state.error = message(error)
        })
        .finally(() => {
          if (state.abort !== abort) return
          state.running = undefined
          state.abort = undefined
          void changed()
        })

      return changed()
    },
    cancel: async () => {
      state.abort?.abort()
      state.abort = undefined
      state.running = undefined

      return changed()
    },
    open: async (id: string) => {
      const report = (await history()).find((item) => item.id === id)

      if (!report) throw new Error("This report is no longer kept.")

      return report
    },
    archive: async (id: string, archived: boolean) => {
      await save((await history()).map((report) => (report.id === id ? { ...report, archived } : report)))

      return changed()
    },
    remove: async (id: string) => {
      await save((await history()).filter((report) => report.id !== id))

      return changed()
    },
    pdf: async (html: string) => {
      const chrome = findChrome()

      if (!chrome) throw new Error("Google Chrome is needed to make the PDF. Install it, or set CHROME_PATH.")

      return { base64: (await printPdf({ html, chrome })).toString("base64") }
    },
    close: () => state.abort?.abort(),
  }
}

/** An address as typed, with `https://` when it names no scheme. */
export function normalize(url: string) {
  const trimmed = url.trim()
  const parsed = URL.parse(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`)

  if (!parsed || !/^https?:$/.test(parsed.protocol) || !parsed.hostname.includes(".") && parsed.hostname !== "localhost")
    throw new Error("Enter a website address, like example.com.")

  return parsed.href
}

const message = (error: unknown) => (error instanceof Error ? error.message : "The audit could not run.")
