// One project's publishing as the preview sees it: the server's status, the name chosen before the first publish and
// whether it is free, and the action that is running. The toolbar's Publish button and its dialog read one state per
// session. The full Publishing tool keeps its own; both follow the server's events, so they agree.

import { batch, createRoot, onCleanup, runWithOwner, type Accessor, type Owner } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { createKeyed, type MountedSession } from "@opencode/plugin/gui"
import { Publish } from "@opencode/schema/publish"
import { liveAddress, slug } from "../tools/contract"

/** How an RPC call rejects: the server's error, with the publishing failure as its data. */
type Failure = {
  readonly message?: string
  readonly data?: { readonly kind?: Publish.FailureKind; readonly message?: string }
}

export type Problem = { kind: Publish.FailureKind; message: string }

export type Availability =
  | { state: "idle" }
  | { state: "checking" }
  | { state: "available" }
  | { state: "taken"; reason?: string }

// The availability check waits for the user to stop typing.
const DEBOUNCE = 400

type State = {
  status: Publish.Status
  /** The status of the routed project has been read at least once. */
  loaded: boolean
  /** The name the user typed before the first publish; undefined while they kept the suggestion. */
  name?: string
  /** The last availability answer, for the name it was asked for. */
  check?: { name: string; available: boolean; reason?: string }
  action?: "publish" | "cancel"
  error?: Problem
}

export type PublishState = ReturnType<typeof createState>

/** Creates a session's publishing state once and returns it on every later call; drops those of closed sessions. */
export function publishStates(owner: Owner | null, keep: Accessor<readonly string[]>) {
  const states = new Map<string, { state: PublishState; dispose: () => void }>()

  const drop = (key: string) => {
    states.get(key)?.dispose()
    states.delete(key)
  }

  runWithOwner(owner, () => {
    onCleanup(() => [...states.keys()].forEach(drop))
    // Drops the states of sessions whose shell tab closed.
    createKeyed(
      () => keep().join("\u0000"),
      () => [...states.keys()].filter((key) => !keep().includes(key)).forEach(drop),
    )
  })

  return (session: Accessor<MountedSession>) => {
    const key = session().key
    const existing = states.get(key)

    if (existing) return existing.state
    const created = createRoot((dispose) => ({ state: createState(session), dispose }), owner)
    states.set(key, created)

    return created.state
  }
}

function createState(session: Accessor<MountedSession>) {
  const [state, setState] = createStore<State>({ status: empty(), loaded: false })

  // Orders status reads: a read that started before a newer status arrived must not overwrite it.
  let version = 0

  const rpc = () => session().server.client.rpc(Publish.Definition)
  const scope = () => ({ location: { directory: session().directory } })

  // Every Location of the project serves the plugin, so its events say which one sent them.
  const mine = (event: { readonly location?: { readonly directory?: string } }) =>
    event.location?.directory === session().directory

  const apply = (status: Publish.Status) =>
    batch(() => {
      version++
      setState("status", reconcile(status))
      setState("loaded", true)
    })

  const problem = (error: Failure): Problem => ({
    kind: error.data?.kind ?? "other",
    message: error.data?.message ?? error.message ?? "",
  })

  const read = (signal?: AbortSignal) => {
    const current = ++version

    return rpc()
      .status({}, { ...scope(), signal })
      .then(
        (status) => {
          if (current !== version || signal?.aborted) return
          apply(status)
        },
        (error: Failure) => {
          if (current !== version || signal?.aborted) return
          setState("error", problem(error))
        },
      )
  }

  // Runs one action at a time, then reads the status again whatever happened.
  const act = <T>(action: "publish" | "cancel", call: () => Promise<T>) => {
    if (state.action) return Promise.resolve()
    setState({ action, error: undefined })

    return call()
      .then(
        () => undefined,
        (error: Failure) => setState("error", problem(error)),
      )
      .then(async () => {
        await read()
        setState("action", undefined)
      })
  }

  const site = () => state.status.site

  const projectName = () => {
    const current = session()

    return current.listedProject?.name ?? current.project?.name ?? current.directory.split(/[\\/]/).at(-1) ?? ""
  }

  // A claimed name stays; before the first claim the user's draft, else the project name's slug.
  const draft = () => site()?.name ?? state.name ?? slug(projectName())
  const choosing = () => state.loaded && state.status.configured && !site()

  // The status, then every change, again whenever the server reconnects or another project is routed.
  createKeyed(
    () => (session().server.connected ? `${session().server.id}\u0000${session().directory}` : undefined),
    () => {
      const controller = new AbortController()
      const signal = controller.signal
      batch(() => {
        setState("status", reconcile(empty()))
        setState({ loaded: false, name: undefined, check: undefined, error: undefined })
      })
      onCleanup(() => controller.abort())
      onCleanup(
        rpc().events.on(
          "changed",
          (event) => {
            if (mine(event)) apply(event.data)
          },
          { signal },
        ),
      )
      void read(signal)
    },
  )

  // Asks the server whether the name is free once the user stops typing; a newer name aborts the older check.
  createKeyed(
    () => (choosing() ? draft() : undefined),
    (name) => {
      const controller = new AbortController()

      const timer = setTimeout(
        () =>
          void rpc()
            .available({ name }, { ...scope(), signal: controller.signal })
            .then(
              (result) => {
                if (!controller.signal.aborted) setState("check", { name, ...result })
              },
              (error: Failure) => {
                if (!controller.signal.aborted)
                  setState("check", { name, available: false, reason: problem(error).message || undefined })
              },
            ),
        DEBOUNCE,
      )

      onCleanup(() => {
        clearTimeout(timer)
        controller.abort()
      })
    },
  )

  return {
    loaded: () => state.loaded,
    configured: () => state.status.configured,
    site,
    /** The site went live at least once and no deploy runs now. */
    live: () => site()?.publishedAt !== undefined && !state.status.running,
    running: () => state.status.running,
    /** The last finished deploy when it failed, so the dialog can say why. */
    failed: () => {
      const last = state.status.history[0]

      return !state.status.running && last?.status === "failed" ? last : undefined
    },
    detected: () => state.status.detected,
    /** The platform zone the site lives under, before the first publish too. */
    zone: () => site()?.zone ?? state.status.zone,
    /** The platform address of the site; undefined before it exists. */
    address: () => {
      const current = site()

      return current ? liveAddress(current, []) : undefined
    },
    busy: () => state.action,
    error: () => state.error,
    dismissError: () => setState("error", undefined),
    nameDraft: draft,
    /** Whether the name can still be changed: only before the first publish claims it. */
    nameLocked: () => !!site(),
    setName: (name: string) => setState("name", name.trim().toLowerCase()),
    availability: (): Availability => {
      if (!choosing()) return { state: "idle" }
      const name = draft()
      const check = state.check

      if (!name) return { state: "idle" }

      if (!check || check.name !== name) return { state: "checking" }

      return check.available ? { state: "available" } : { state: "taken", reason: check.reason }
    },
    publish: () =>
      act("publish", () => rpc().publish({ name: site() ? undefined : draft(), sessionID: session().id }, scope())),
    cancel: () => act("cancel", () => rpc().cancel({}, scope())),
  }
}

function empty(): Publish.Status {
  return { configured: false, history: [] }
}
