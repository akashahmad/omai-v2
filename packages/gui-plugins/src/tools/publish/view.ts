// One project's publishing as the window sees it: the server's status (the site, the running deploy and the history),
// the name chosen before the first publish and whether it is free, the running deploy's live log, and the action that
// is running. The pipeline runs on the server and reports every change as an event; the panel renders from this view.

import { batch, createRoot, onCleanup, runWithOwner, type Accessor, type Owner } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { createKeyed, type MountedSession } from "@opencode/plugin/gui"
import { Publish } from "@opencode/schema/publish"
import { fixPrompt, liveAddress, primaryDomain, slug, type Translate } from "./model"

/** How an RPC call rejects: the server's error, with the publishing failure as its data. */
type Failure = {
  readonly message?: string
  readonly data?: { readonly kind?: Publish.FailureKind; readonly message?: string }
}

export type Problem = { kind: Publish.FailureKind; message: string }

export type Action = "publish" | "cancel" | "remove" | "ask"

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
  /** The custom domains, read only to know whether the primary is active. */
  domains: Publish.Domain[]
  /** The name the user typed before the first publish; undefined while they kept the suggestion. */
  name?: string
  /** The last availability answer, for the name it was asked for. */
  check?: { name: string; available: boolean; reason?: string }
  action?: Action
  error?: Problem
  /** The running deploy's log so far. */
  log: { id?: string; text: string }
  /** A finished deploy's log on screen; `text` is undefined while it loads. */
  opened?: { id: string; text?: string }
}

export type PublishView = ReturnType<typeof createView>

/** Creates a session's view once and returns it on every later call, so the panel keeps it across renders. */
export function publishViews(owner: Owner | null, keep: Accessor<readonly string[]>) {
  const views = new Map<string, { view: PublishView; dispose: () => void }>()

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
    domains: [],
    log: { text: "" },
  })

  // Orders status reads: a read that started before a newer status arrived must not overwrite it.
  let version = 0

  const rpc = () => session().server.client.rpc(Publish.Definition)
  const domainsRpc = () => session().server.client.rpc(Publish.DomainsDefinition)
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

  // Runs one action at a time, then reads the status again whatever happened. Resolves with what the call returned when
  // it worked, undefined when it failed or another action was running.
  const act = <T>(action: Action, call: () => Promise<T>): Promise<T | undefined> => {
    if (state.action) return Promise.resolve(undefined)
    setState({ action, error: undefined })

    return call()
      .then(
        (value) => ({ value }),
        (error: Failure) => {
          setState("error", problem(error))

          return undefined
        },
      )
      .then(async (done) => {
        await read()
        setState("action", undefined)

        return done?.value
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
        setState({
          loaded: false,
          domains: [],
          name: undefined,
          check: undefined,
          error: undefined,
          log: { text: "" },
          opened: undefined,
        })
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

  // The running deploy's log: what the server kept so far, then each chunk as it is written.
  createKeyed(
    () => (session().server.connected ? state.status.running?.id : undefined),
    (id) => {
      const controller = new AbortController()
      const signal = controller.signal
      // Chunks that arrive while the kept log loads; the kept log may already end with them.
      const early = { text: "", loaded: false }
      setState("log", { id, text: "" })
      onCleanup(() => controller.abort())
      onCleanup(
        rpc().events.on(
          "log",
          (event) => {
            if (event.data.id !== id || !mine(event)) return

            if (!early.loaded) early.text += event.data.chunk
            setState("log", "text", (text) => text + event.data.chunk)
          },
          { signal },
        ),
      )
      void rpc()
        .log({ id }, { ...scope(), signal })
        .then(
          (result) => {
            early.loaded = true

            if (signal.aborted) return
            setState("log", "text", result.text.endsWith(early.text) ? result.text : result.text + early.text)
          },
          () => {
            early.loaded = true
          },
        )
    },
  )

  // The custom domains, only to tell whether the primary is active, which decides the address the panel shows.
  createKeyed(
    () =>
      session().server.connected && site()?.primary ? `${session().directory}\u0000${site()?.primary}` : undefined,
    () => {
      const controller = new AbortController()
      const signal = controller.signal
      const take = (domains: Publish.Domains) => setState("domains", reconcile(domains.domains.slice(), { key: "hostname" }))
      onCleanup(() => controller.abort())
      onCleanup(
        domainsRpc().events.on(
          "changed",
          (event) => {
            if (mine(event)) take(event.data)
          },
          { signal },
        ),
      )
      void domainsRpc()
        .list({}, { ...scope(), signal })
        .then(
          (domains) => {
            if (!signal.aborted) take(domains)
          },
          () => undefined,
        )
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
                  setState("check", { name, available: false, reason: problem(error).message || t("publish.failed") })
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

  const logOf = (id: string) =>
    rpc()
      .log({ id }, scope())
      .then((result) => result.text)

  return {
    state,
    status: () => state.status,
    loaded: () => state.loaded,
    configured: () => state.status.configured,
    site,
    /** The site went live at least once. */
    published: () => site()?.publishedAt !== undefined,
    running: () => state.status.running,
    history: () => state.status.history,
    detected: () => state.status.detected,
    /** The platform zone the site lives under, before the first publish too. */
    zone: () => site()?.zone ?? state.status.zone,
    /** The address visitors use; undefined before the site exists. */
    address: () => {
      const current = site()

      return current ? liveAddress(current, state.domains) : undefined
    },
    /** The primary custom domain, when one is set; it serves visitors only once active. */
    primary: () => {
      const current = site()

      return current ? primaryDomain(current, state.domains) : undefined
    },
    busy: () => state.action,
    error: () => state.error,
    dismissError: () => setState("error", undefined),
    refresh: () => read(),
    /** The running deploy's log so far; empty when nothing runs. */
    log: () => (state.log.id === state.status.running?.id ? state.log.text : ""),
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
    /** Starts a deploy; resolves with it, or undefined when the server refused (the panel shows the error). */
    publish: () =>
      act("publish", () => rpc().publish({ name: site() ? undefined : draft(), sessionID: session().id }, scope())),
    cancel: () => act("cancel", () => rpc().cancel({}, scope())),
    /** Deletes the site, its domains and its history. Resolves true once it is gone. */
    remove: (confirm: string) => act("remove", () => rpc().remove({ confirm }, scope())).then((done) => !!done),
    /** Shows a finished deploy's log, or hides it when it is the one on screen. */
    openLog: (id: string) => {
      if (state.opened?.id === id) return setState("opened", undefined)
      setState("opened", { id })
      void logOf(id).then(
        (text) => {
          if (state.opened?.id === id) setState("opened", { id, text })
        },
        (error: Failure) => {
          if (state.opened?.id !== id) return
          batch(() => {
            setState("opened", undefined)
            setState("error", problem(error))
          })
        },
      )
    },
    opened: () => state.opened,
    /** Asks this conversation's agent to fix a failed deploy, with the reason and the end of its log. */
    askAI: (deploy: Publish.Deploy) =>
      act("ask", async () => {
        const text = fixPrompt(deploy, await logOf(deploy.id))
        await session().server.data.session.prompt({ sessionID: session().id, text })

        return true
      }).then((done) => !!done),
    /** The project's latest preview screenshot as WebP bytes; rejects when the preview never ran. */
    thumbnail: (signal: AbortSignal) => {
      const projectID = session().project?.id

      if (!projectID) return Promise.reject(new Error("no project"))

      return session().server.client.experimental.preview.thumbnail({ projectID }, { signal })
    },
  }
}

function empty(): Publish.Status {
  return { configured: false, history: [] }
}
