// One project's website audit as the window sees it: the server's audit status, the report on screen, and the fix the
// agent is working on. The audit runs on the server, so it carries on while the panel is closed.

import { batch, createMemo, createRoot, createSignal, onCleanup, type Accessor, type Owner } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { createKeyed, type MountedSession } from "@opencode/plugin/gui"
import { Audit } from "@opencode/schema/audit"
import { compare, fixPrompt, type Comparison, type Target, type Translate } from "./model"

/** How an RPC call or a prompt rejects. */
type Failure = { readonly message?: string } | undefined

export type FixPhase = "idle" | "asking" | "running" | "auditing" | "stopped" | "done" | "error"

type State = {
  status: Audit.Status
  /** The report on screen: the newest one unless the user opened another from the history. */
  openedID?: string
  opened?: Audit.Report
  formFactor: Audit.FormFactor
  target: "preview" | "url"
  url: string
  /** Why the last action failed, in one sentence. */
  error?: string
  fix: {
    phase: FixPhase
    target?: Target
    baseline?: Audit.Report
    startedAt?: number
    sawBusy: boolean
    comparison?: Comparison
    error?: string
  }
}

export type AuditView = ReturnType<typeof createView>

/** Creates a session's view once and returns it on every later call, so the panel keeps it across renders. */
export function auditViews(owner: Owner | null) {
  const views = new Map<string, AuditView>()

  return (session: Accessor<MountedSession>, t: Translate, locale: Accessor<string>) => {
    const key = session().key
    const existing = views.get(key)

    if (existing) return existing
    const created = createRoot(() => createView(session, t, locale), owner)
    views.set(key, created)

    return created
  }
}

function createView(session: Accessor<MountedSession>, t: Translate, locale: Accessor<string>) {
  const [state, setState] = createStore<State>({
    status: { history: [] },
    formFactor: "mobile",
    target: "preview",
    url: "",
    fix: { phase: "idle", sawBusy: false },
  })

  const [now, setNow] = createSignal(Date.now())

  const rpc = () => session().server.client.rpc(Audit.Definition)
  const scope = () => ({ location: { directory: session().directory } })
  const mine = (directory: string | undefined) => !directory || directory === session().directory
  const agentBusy = () => session().server.data.session.status(session().id) === "running"

  const report = createMemo(() =>
    state.openedID && state.opened?.id === state.openedID ? state.opened : state.status.latest,
  )

  const fixActive = () => ["asking", "running", "auditing"].includes(state.fix.phase)
  const running = () => !!state.status.running

  const apply = (status: Audit.Status) =>
    batch(() => {
      const finished = state.status.running && !status.running
      // Replace, not merge: a finished status leaves out `running`, which a merge would keep.
      setState("status", reconcile(status))

      // A new report replaces one the user opened from the history.
      if (finished && status.latest) setState({ openedID: undefined, opened: undefined })

      if (state.fix.phase === "auditing" && finished) settle(status)
    })

  // The re-measure after the agent's fixes ended: compare it with the report the fixes started from.
  const settle = (status: Audit.Status) => {
    const before = state.fix.baseline
    const after = status.latest

    if (!before || !after || after.id === before.id)
      return setState("fix", { phase: "error", error: status.error ?? t("optimize.auditFailed") })
    setState("fix", { phase: "done", comparison: compare(before, after, state.fix.target, t) })
  }

  // The status, then every change, again whenever the server reconnects or another project is routed.
  createKeyed(
    () => (session().server.connected ? `${session().server.id}\u0000${session().directory}` : undefined),
    () => {
      const controller = new AbortController()
      const signal = controller.signal
      onCleanup(() => controller.abort())
      onCleanup(
        rpc().events.on(
          "changed",
          (event) => {
            if (mine(event.data.directory)) apply(event.data)
          },
          { signal },
        ),
      )
      void rpc()
        .status({}, { ...scope(), signal })
        .then(
          (status) => !signal.aborted && apply(status),
          () => undefined,
        )
    },
  )

  // Follows the agent while it works on the fixes: once it went busy and is idle again, the audit runs again.
  createKeyed(
    () => (state.fix.phase === "running" ? (agentBusy() ? "busy" : "idle") : undefined),
    (activity) => {
      if (activity === "busy") return setState("fix", "sawBusy", true)

      if (state.fix.sawBusy) remeasure()
    },
  )

  // The elapsed time of a fix, while one runs.
  createKeyed(
    () => fixActive() || running(),
    () => {
      setNow(Date.now())
      const timer = setInterval(() => setNow(Date.now()), 1000)
      onCleanup(() => clearInterval(timer))
    },
  )

  // RPC calls reject with the server's error, which carries a message like any Error.
  const reason = (error: Failure) => error?.message ?? ""

  const run = (input: { formFactor: Audit.FormFactor; url?: string }) =>
    rpc()
      .run({ formFactor: input.formFactor, url: input.url, locale: locale() }, scope())
      .then(
        (status) => {
          setState("error", undefined)
          apply(status)

          return true
        },
        (error: Failure) => {
          setState("error", reason(error) || t("failed", { reason: "" }))

          return false
        },
      )

  const remeasure = () => {
    const baseline = state.fix.baseline

    if (!baseline) return
    setState("fix", { phase: "auditing", sawBusy: false })
    void run({ formFactor: baseline.formFactor, url: baseline.preview ? undefined : baseline.url }).then((ok) => {
      if (!ok) setState("fix", { phase: "error", error: t("optimize.auditFailed") })
    })
  }

  return {
    state,
    report,
    running,
    fixActive,
    agentBusy,
    elapsed: () => now() - (state.fix.startedAt ?? now()),
    auditElapsed: () => now() - (state.status.running?.startedAt ?? now()),
    canFix: () => {
      const current = report()

      return !!current && current.preview && !running() && !agentBusy() && !fixActive()
    },
    setFormFactor: (formFactor: Audit.FormFactor) => setState("formFactor", formFactor),
    setTarget: (target: "preview" | "url") => setState("target", target),
    setURL: (url: string) => setState("url", url),
    run: () => void run({ formFactor: state.formFactor, url: state.target === "url" ? state.url : undefined }),
    /** Runs the report on screen again, with its own target and screen. */
    retest: () => {
      const current = report()

      if (!current) return
      void run({ formFactor: current.formFactor, url: current.preview ? undefined : current.url })
    },
    cancel: () => void rpc().cancel({}, scope()).then(apply, () => undefined),
    open: (id: string) => {
      if (id === state.status.latest?.id) return setState({ openedID: undefined, opened: undefined })
      setState("openedID", id)
      void rpc()
        .open({ id }, scope())
        .then(
          (opened) => state.openedID === id && setState("opened", reconcile(opened)),
          (error: Failure) => setState({ openedID: undefined, error: reason(error) }),
        )
    },
    remove: (id: string) =>
      void rpc()
        .remove({ id }, scope())
        .then((status) => {
          if (state.openedID === id) setState({ openedID: undefined, opened: undefined })
          apply(status)
        }, () => undefined),
    pdf: (html: string) => rpc().pdf({ html }, scope()),
    fix: (target?: Target) => {
      const current = report()

      if (!current) return
      setState("fix", {
        phase: "asking",
        target,
        baseline: current,
        startedAt: Date.now(),
        sawBusy: false,
        comparison: undefined,
        error: undefined,
      })
      void session()
        .server.data.session.prompt({ sessionID: session().id, text: fixPrompt(current, target, t) })
        .then(
          () => state.fix.phase === "asking" && setState("fix", "phase", "running"),
          (error: Failure) => setState("fix", { phase: "error", error: t("optimize.failed", { reason: reason(error) }) }),
        )
    },
    stopFix: () => {
      setState("fix", { phase: "stopped", sawBusy: false })
      void session()
        .server.client.session.interrupt({ sessionID: session().id })
        .catch(() => undefined)
    },
    dismissFix: () => setState("fix", { phase: "idle", target: undefined, baseline: undefined, comparison: undefined }),
  }
}
