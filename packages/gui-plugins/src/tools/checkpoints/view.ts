// One conversation's checkpoints as the window sees it: the tree the server derives, the checkpoint on screen and its
// changes, and the jump or undo that is running. The conversation itself follows a jump through the app's session data,
// which reloads a session's messages when its path is swapped.

import { batch, createRoot, onCleanup, runWithOwner, type Accessor, type Owner } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { createKeyed, type MountedSession } from "@opencode/plugin/gui"
import { Checkpoint } from "@opencode/schema/checkpoint"
import type { FileDiff } from "@opencode/schema/file-diff"
import { failureText, holdsRefusal, type Words } from "./model"

/** How an RPC call rejects: the server's error type and message, with the busy session as data. */
type Failure = { readonly type?: string; readonly message?: string; readonly data?: { readonly session?: string } }

export type Mode = "change" | "now"

export type Action = "jump" | "undo" | "enable"

type State = {
  listing: Checkpoint.Listing
  /** The listing of the routed conversation has been read at least once. */
  loaded: boolean
  selected?: string
  mode: Mode
  /** The changes on screen, for the checkpoint and mode they were read for. */
  diff?: { key: string; mode: Mode; files: FileDiff.Info[] }
  diffFailed: boolean
  action?: Action
  /** Why the last read or action failed, in one sentence. */
  error?: string
  /** The session the server named when it refused a jump because it was working. */
  blocked?: string
}

/** Who is working in this project, which blocks a jump. `mine` is this conversation (or one of its subagents). */
export type Working = { id: string; title: string; mine: boolean }

export type CheckpointView = ReturnType<typeof createView>

// Undo retries a refusal that names this conversation, which a jump to its newest checkpoint briefly wakes.
const RETRY = { attempts: 3, delay: 400 }

/** Creates a session's view once and returns it on every later call, so the panel keeps it across renders. */
export function checkpointViews(owner: Owner | null, keep: Accessor<readonly string[]>) {
  const views = new Map<string, { view: CheckpointView; dispose: () => void }>()

  const drop = (key: string) => {
    views.get(key)?.dispose()
    views.delete(key)
  }

  runWithOwner(owner, () => {
    onCleanup(() => [...views.keys()].forEach(drop))
    // Drops the views of sessions whose shell tab closed.
    createKeyed(
      () => keep().join("\u0000"),
      () => [...views.keys()].filter((key) => !keep().includes(key)).forEach(drop),
    )
  })

  return (session: Accessor<MountedSession>, words: Words) => {
    const key = session().key
    const existing = views.get(key)

    if (existing) return existing.view
    const created = createRoot((dispose) => ({ view: createView(session, words), dispose }), owner)
    views.set(key, created)

    return created.view
  }
}

function createView(session: Accessor<MountedSession>, words: Words) {
  const [state, setState] = createStore<State>({
    listing: { available: true, nodes: [] },
    loaded: false,
    mode: "change",
    diffFailed: false,
  })

  // Orders reads: a listing or diff that started before a newer one must not overwrite it.
  let version = 0
  let diffVersion = 0

  const rpc = () => session().server.client.rpc(Checkpoint.Definition)
  const scope = () => ({ location: session().location ?? { directory: session().directory } })
  const data = () => session().server.data.session

  const titleOf = (id: string) => {
    const root = data().root(id)

    return data().get(root)?.title || words.t("checkpoints.untitled")
  }

  // The first running session in this project; the server refuses a jump while any runs.
  const working = (): Working | undefined => {
    const projectID = data().get(session().id)?.projectID

    const id = [session().id, ...data().active()].find(
      (item) =>
        data().status(item) === "running" && (item === session().id || data().get(item)?.projectID === projectID),
    )

    if (id) return { id, title: titleOf(id), mine: data().root(id) === session().id }

    // A refusal can name a session this window does not list for the project; it applies only while that one runs.
    const blocked = state.blocked

    return blocked && holdsRefusal({ known: !!data().get(blocked), running: data().status(blocked) === "running" })
      ? refusal(blocked)
      : undefined
  }

  // The checkpoint the details show: the one the user picked, else the one they are on.
  const shown = () => state.selected ?? state.listing.current

  const refusal = (id: string): Working => ({ id, title: titleOf(id), mine: data().root(id) === session().id })

  const read = (signal?: AbortSignal) => {
    const current = ++version

    return rpc()
      .list({ sessionID: session().id }, { ...scope(), signal })
      .then(
        (listing) => {
          if (current !== version || signal?.aborted) return
          batch(() => {
            setState("listing", reconcile(listing))
            setState({ loaded: true, error: undefined })

            if (state.selected && !listing.nodes.some((node) => node.key === state.selected))
              setState({ selected: undefined, diff: undefined })
          })

          // The files on screen may have changed with the conversation, so the open diff is read again.
          const key = shown()

          if (key) void loadDiff(key, state.mode)
        },
        (error: Failure) => {
          if (current !== version || signal?.aborted) return
          setState("error", failureText(error, words))
        },
      )
  }

  const loadDiff = (key: string, mode: Mode) => {
    const current = ++diffVersion
    setState("diffFailed", false)

    return rpc()
      .diff({ sessionID: session().id, key, mode }, scope())
      .then(
        (result) => {
          if (current !== diffVersion) return
          setState("diff", { key, mode, files: result.files.slice() })
        },
        () => {
          if (current === diffVersion) setState("diffFailed", true)
        },
      )
  }

  // Runs one action at a time; a refusal because someone is working names them instead of failing.
  const act = <T>(action: Action, call: () => Promise<T>): Promise<T | undefined> => {
    if (state.action) return Promise.resolve(undefined)
    setState({ action, error: undefined, blocked: undefined })

    return call()
      .then(
        (value) => ({ value }),
        (error: Failure) => {
          if (error.type === "checkpoint.busy" && error.data?.session) setState("blocked", error.data.session)

          if (error.type !== "checkpoint.busy") setState("error", failureText(error, words))

          return undefined
        },
      )
      .then(async (done) => {
        await read()
        setState("action", undefined)

        return done?.value
      })
  }

  // Undo right after a jump to the newest checkpoint can find the conversation briefly busy: that jump wakes it.
  const undoCall = async (attempt = 0): Promise<{ done: boolean }> =>
    rpc()
      .undo({ sessionID: session().id }, scope())
      .catch(async (error: Failure) => {
        if (error.type !== "checkpoint.busy" || error.data?.session !== session().id || attempt >= RETRY.attempts - 1)
          throw error
        await new Promise((resolve) => setTimeout(resolve, RETRY.delay))

        return undoCall(attempt + 1)
      })

  // The listing, then every change, again whenever the server reconnects or another conversation is routed.
  createKeyed(
    () =>
      session().server.connected
        ? `${session().server.id}\u0000${session().id}\u0000${session().directory}`
        : undefined,
    () => {
      const controller = new AbortController()
      const signal = controller.signal
      batch(() => {
        setState("listing", reconcile({ available: true, nodes: [] }))
        setState({ loaded: false, selected: undefined, diff: undefined, error: undefined, blocked: undefined })
      })
      onCleanup(() => controller.abort())
      onCleanup(
        rpc().events.on(
          "changed",
          (event) => {
            if (event.data.sessionID === session().id) void read()
          },
          { signal },
        ),
      )
      void read(signal)
    },
  )

  const node = (key: string | undefined) => state.listing.nodes.find((item) => item.key === key)

  return {
    state,
    loaded: () => state.loaded,
    available: () => state.listing.available,
    nodes: () => state.listing.nodes,
    current: () => node(state.listing.current),
    selected: () => node(shown()),
    mode: () => state.mode,
    /** The changes of the selected checkpoint in the chosen mode; undefined while they load. */
    diff: () => {
      const diff = state.diff

      return diff && diff.key === shown() && diff.mode === state.mode ? diff.files : undefined
    },
    diffFailed: () => state.diffFailed,
    busy: () => state.action,
    working,
    error: () => state.error,
    dismissError: () => setState("error", undefined),
    refresh: () => read(),
    select: (key: string | undefined) => {
      if (key === state.selected) return
      setState({ selected: key, diffFailed: false })
      const target = shown()

      if (target) void loadDiff(target, state.mode)
    },
    setMode: (mode: Mode) => {
      if (mode === state.mode) return
      setState("mode", mode)

      const key = shown()

      if (key) void loadDiff(key, mode)
    },
    retryDiff: () => {
      const key = shown()

      if (key) void loadDiff(key, state.mode)
    },
    /** The files a jump to this checkpoint would put back: those that differ from it now. */
    overwritten: (key: string) =>
      rpc()
        .diff({ sessionID: session().id, key, mode: "now" }, scope())
        .then((result) => result.files.map((file) => file.file)),
    /**
     * Resolves true once the conversation and files are at the checkpoint, the session that was working when the
     * server refused, and false on any other failure (the panel shows the error).
     */
    jump: (key: string) =>
      act("jump", () => rpc().jump({ sessionID: session().id, key }, scope())).then((done) => {
        if (!done) return state.blocked ? refusal(state.blocked) : false

        return true
      }),
    /**
     * Resolves true when it undid the last jump, false when there was nothing to undo, "waiting" when another action
     * is still running, the session that was working when the server refused, and undefined on any other failure.
     */
    undo: () => {
      if (state.action) return Promise.resolve("waiting" as const)

      return act("undo", () => undoCall()).then((result) => {
        if (!result && state.blocked) return refusal(state.blocked)

        return result?.done
      })
    },
    stopAgent: () =>
      void session()
        .server.client.session.interrupt({ sessionID: session().id })
        .catch((error: Failure) =>
          setState(
            "error",
            words.t("checkpoints.stop.failed", { reason: error.message || words.t("checkpoints.error.failed") }),
          ),
        ),
    /** Creates the Git repository snapshots need. Commits nothing. */
    enable: () =>
      act("enable", async () => {
        const target = session()
        const location = target.location ?? { directory: target.directory }
        await target.server.client.vcs.init({ location, provider: "git" })
        const store = target.server.data
        store.project.invalidate()
        store.location.invalidate(location)
        store.location.vcs.invalidate(location)
        await Promise.all([store.project.sync(), store.location.vcs.sync(location)]).catch(() => undefined)

        return true
      }),
  }
}
