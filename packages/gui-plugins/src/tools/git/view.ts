// One project's Git state as the window sees it: the repository's status, the action that is running, the file or commit
// on screen and the history. Git runs on the server; the panel renders from this view, which re-reads the status after
// every action, whether it worked or not, because a failed pull can still leave a merge in progress.

import { batch, createRoot, onCleanup, runWithOwner, type Accessor, type Owner } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { createKeyed, type MountedSession } from "@opencode/plugin/gui"
import { GitTool } from "@opencode/schema/git-tool"
import { groups, pathsOf, resolvePrompt, summary, type Translate } from "./model"

/** How an RPC call rejects: the server's error, with the Git failure as its data. */
type Failure = { readonly message?: string; readonly data?: Partial<Problem> }

export type Action =
  | "stage"
  | "discard"
  | "commit"
  | "profile"
  | "push"
  | "pull"
  | "fetch"
  | "abort"
  | "continue"
  | "remote"
  | "branch"
  | "init"

export type Problem = { kind: GitTool.FailureKind; message: string; details: string }

type Selection = { path: string; staged: boolean } | { hash: string }

const PAGE = 50

type State = {
  status: GitTool.Status
  /** The status of the routed project has been read at least once. */
  loaded: boolean
  busy?: Action
  error?: Problem
  selected?: Selection
  /** The commits loaded so far, newest first. */
  commits: GitTool.Commit[]
  more: boolean
  loading: boolean
  /** The files of the commit on screen. */
  commit?: { commit: GitTool.Commit; files: GitTool.FileChange[] }
}

export type GitView = ReturnType<typeof createView>

/** Creates a session's view once and returns it on every later call, so the panel keeps it across renders. */
export function gitViews(owner: Owner | null, keep: Accessor<readonly string[]>) {
  const views = new Map<string, { view: GitView; dispose: () => void }>()

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

  return (session: Accessor<MountedSession>, t: Translate) => {
    const key = session().key
    const existing = views.get(key)

    if (existing) return existing.view
    const created = createRoot((dispose) => ({ view: createView(session, t), dispose }), owner)
    views.set(key, created)

    return created.view
  }
}

function createView(session: Accessor<MountedSession>, t: Translate) {
  const [state, setState] = createStore<State>({
    status: empty(),
    loaded: false,
    commits: [],
    more: false,
    loading: false,
  })

  // Orders status reads: a read that started before a newer status arrived must not overwrite it.
  let version = 0
  let sawBusy = false
  // The history was asked for in this project, so every new status reloads it, even while it was empty.
  let logged = false

  const rpc = () => session().server.client.rpc(GitTool.Definition)
  const scope = () => ({ location: { directory: session().directory } })
  const agentBusy = () => session().server.data.session.status(session().id) === "running"

  const apply = (status: GitTool.Status) =>
    batch(() => {
      version++
      setState("status", reconcile(status))
      setState("loaded", true)
      const selected = state.selected

      if (selected && "path" in selected && !status.files.some((file) => file.path === selected.path))
        setState("selected", undefined)
    })

  const problem = (error: Failure): Problem => ({
    kind: error.data?.kind ?? "other",
    message: error.data?.message ?? error.message ?? t("git.failed"),
    details: error.data?.details ?? "",
  })

  // Reads the status; a read that a newer status overtook is dropped. A failed read says so instead of keeping a stale
  // status on screen.
  const read = (signal?: AbortSignal) => {
    const current = ++version

    return rpc()
      .status({}, { ...scope(), signal })
      .then(
        (status) => {
          if (current !== version || signal?.aborted) return
          apply(status)

          if (logged) void loadLog(true)
        },
        (error: Failure) => {
          if (signal?.aborted || current !== version) return
          setState("error", problem(error))
        },
      )
  }

  const refresh = () => read()

  // One page at a time, by offset from HEAD; a page whose offset no longer matches the list (a reset or another project) is dropped.
  const loadLog = (reset: boolean) => {
    if (state.loading && !reset) return Promise.resolve()
    const skip = reset ? 0 : state.commits.length
    const directory = session().directory
    logged = true
    setState("loading", true)

    return rpc()
      .log({ skip, limit: PAGE }, scope())
      .then(
        (page) => {
          if (directory !== session().directory || skip !== (reset ? 0 : state.commits.length)) return
          batch(() => {
            setState("commits", reset ? reconcile(page.commits.slice()) : (commits) => [...commits, ...page.commits])
            setState("more", page.more)
          })
        },
        (error: Failure) => setState("error", problem(error)),
      )
      .then(() => setState("loading", false))
  }

  // Runs one action, then reads the status again whatever happened. One action runs at a time. Resolves with what the
  // call returned when it worked, undefined when it failed or another action was running.
  const act = <T>(action: Action, call: () => Promise<T>): Promise<T | undefined> => {
    if (state.busy) return Promise.resolve(undefined)
    setState({ busy: action, error: undefined })

    return call()
      .then(
        (value) => ({ value }),
        (error: Failure) => {
          setState("error", problem(error))

          return undefined
        },
      )
      .then(async (done) => {
        const failed = state.error
        await refresh()

        // A failed read replaces nothing the action said; the action's own error stays.
        if (failed) setState("error", failed)

        setState("busy", undefined)

        return state.error ? undefined : done?.value
      })
  }

  // The status, then every change, again whenever the server reconnects or another project is routed.
  createKeyed(
    () => (session().server.connected ? `${session().server.id}\u0000${session().directory}` : undefined),
    () => {
      const controller = new AbortController()
      const signal = controller.signal
      // Nothing of the previous project stays on screen, and nothing of it is appended to.
      logged = false
      batch(() => {
        setState("status", reconcile(empty()))
        setState({
          loaded: false,
          commits: [],
          more: false,
          loading: false,
          selected: undefined,
          commit: undefined,
          error: undefined,
        })
      })
      onCleanup(() => controller.abort())
      onCleanup(
        rpc().events.on(
          "changed",
          // The payload carries no directory, so it only says something changed; the scoped read says what.
          () => void refresh(),
          { signal },
        ),
      )
      void read(signal)
    },
  )

  // The agent edits files and runs git itself, so the status is read again when it goes from running to idle.
  createKeyed(
    () => (agentBusy() ? "busy" : "idle"),
    (activity) => {
      if (activity === "busy") {
        sawBusy = true

        return
      }

      if (!sawBusy) return
      sawBusy = false
      void refresh()
    },
  )

  const files = () => groups(state.status.files)

  return {
    state,
    status: () => state.status,
    loaded: () => state.loaded,
    busy: () => state.busy,
    error: () => state.error,
    selected: () => state.selected,
    summary: () => summary(state.status, t),
    groups: files,
    refresh,
    dismissError: () => setState("error", undefined),
    toggle: (path: string) => {
      const file = state.status.files.find((item) => item.path === path)

      if (!file) return
      void act("stage", () =>
        rpc().stage(
          { paths: pathsOf([file], file.staged && !file.unstaged), staged: !(file.staged && !file.unstaged) },
          scope(),
        ),
      )
    },
    /** Stages the files, or unstages them when `staged` is false. */
    stage: (files: readonly GitTool.FileChange[], staged: boolean) =>
      void act("stage", () => rpc().stage({ paths: pathsOf(files, !staged), staged }, scope())),
    toggleAll: (staged: boolean) => {
      const paths = pathsOf(staged ? files().staged : files().changes, staged)

      if (paths.length === 0) return
      void act("stage", () => rpc().stage({ paths, staged: !staged }, scope()))
    },
    discard: (files: readonly GitTool.FileChange[]) =>
      act("discard", () => rpc().discard({ paths: pathsOf(files, true) }, scope())),
    commit: (message: string, options: { amend?: boolean } = {}) =>
      act("commit", () => rpc().commit({ message, amend: options.amend }, scope())),
    saveProfile: (input: { name: string; email: string; global: boolean }) =>
      act("profile", () => rpc().profile(input, scope())),
    push: (remote?: string) => act("push", () => rpc().push({ remote }, scope())),
    pull: (mode?: "ff-only" | "rebase" | "merge") => act("pull", () => rpc().pull({ mode }, scope())),
    fetch: () => act("fetch", () => rpc().fetch({}, scope())),
    abort: () => act("abort", () => rpc().abort({}, scope())),
    /** Finishes the rebase or merge once no conflicted file remains. */
    continue: () => act("continue", () => rpc().continue({}, scope())),
    init: () => act("init", () => rpc().init({}, scope())),
    remoteAdd: (name: string, url: string) => act("remote", () => rpc().remoteAdd({ name, url }, scope())),
    remoteSet: (name: string, url: string) => act("remote", () => rpc().remoteSet({ name, url }, scope())),
    remoteRemove: (name: string) => act("remote", () => rpc().remoteRemove({ name }, scope())),
    branchCreate: (name: string) => act("branch", () => rpc().branchCreate({ name }, scope())),
    branchSwitch: (name: string) => act("branch", () => rpc().branchSwitch({ name }, scope())),
    commits: () => state.commits,
    hasMore: () => state.more,
    /** The first page of history, then each next page. */
    loadMore: () => void loadLog(state.commits.length === 0),
    /** The change of a file, from the working tree, the index or a commit. */
    diff: (file: GitTool.FileChange, options: { staged?: boolean; commit?: string } = {}) =>
      rpc().diff({ path: file.path, oldPath: file.oldPath, staged: options.staged, commit: options.commit }, scope()),
    open: (target: Selection) => {
      setState({ selected: target, commit: undefined })

      if (!("hash" in target)) return
      void rpc()
        .show({ hash: target.hash }, scope())
        .then(
          (shown) => {
            const selected = state.selected

            if (selected && "hash" in selected && selected.hash === target.hash)
              setState("commit", { commit: shown.commit, files: shown.files.slice() })
          },
          (error: Failure) => setState("error", problem(error)),
        )
    },
    close: () => setState({ selected: undefined, commit: undefined }),
    commitOnScreen: () => state.commit,
    /** Hands the conflicted files to the session's agent. */
    askToResolve: () =>
      session()
        .server.data.session.prompt({ sessionID: session().id, text: resolvePrompt(files().conflicted) })
        .then(
          () => true,
          (error: Failure) => {
            setState("error", problem(error))

            return false
          },
        ),
  }
}

function empty(): GitTool.Status {
  return {
    repo: false,
    detached: false,
    ahead: 0,
    behind: 0,
    files: [],
    remotes: [],
    branches: [],
    profile: { scope: "none" },
  }
}
