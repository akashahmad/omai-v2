// One project's custom domains as the window sees it: the server's list (the site they point at, the platform
// subdomain and every domain with its DNS records), and the action that is running. Domains change on the server, which
// reports every change as an event; the panel renders from this view.

import { batch, createRoot, onCleanup, runWithOwner, type Accessor, type Owner } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { createKeyed, type MountedSession } from "@opencode/plugin/gui"
import { Publish } from "@opencode/schema/publish"
import { LIMIT, RECHECK, sortDomains, suggestion } from "./model"

/** How an RPC call rejects: the server's error, with the publishing failure as its data. */
type Failure = {
  readonly message?: string
  readonly data?: { readonly kind?: Publish.FailureKind; readonly message?: string }
}

export type Problem = { kind: Publish.FailureKind; message: string }

export type Action = "add" | "remove" | "primary" | "check"

type State = {
  domains: Publish.Domains
  /** The domains of the routed project have been read at least once. */
  loaded: boolean
  action?: Action
  /** The hostname the running action is about, to show its spinner on the right card. */
  target?: string
  error?: Problem
}

export type DomainsView = ReturnType<typeof createView>

/** Creates a session's view once and returns it on every later call, so the panel keeps it across renders. */
export function domainsViews(owner: Owner | null, keep: Accessor<readonly string[]>) {
  const views = new Map<string, { view: DomainsView; dispose: () => void }>()

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

  return (session: Accessor<MountedSession>) => {
    const key = session().key
    const existing = views.get(key)

    if (existing) return existing.view
    const created = createRoot((dispose) => ({ view: createView(session), dispose }), owner)
    views.set(key, created)

    return created.view
  }
}

function createView(session: Accessor<MountedSession>) {
  const [state, setState] = createStore<State>({ domains: empty(), loaded: false })

  // Orders reads: a read that started before a newer list arrived must not overwrite it.
  let version = 0

  const rpc = () => session().server.client.rpc(Publish.DomainsDefinition)
  const scope = () => ({ location: { directory: session().directory } })

  // Every Location of the project serves the plugin, so its events say which one sent them.
  const mine = (event: { readonly location?: { readonly directory?: string } }) =>
    event.location?.directory === session().directory

  const apply = (domains: Publish.Domains) =>
    batch(() => {
      version++
      // Matched by hostname, so a card keeps its state when another domain is added or removed before it.
      setState("domains", reconcile(domains, { key: "hostname" }))
      setState("loaded", true)
    })

  const problem = (error: Failure): Problem => ({
    kind: error.data?.kind ?? "other",
    message: error.data?.message ?? error.message ?? "",
  })

  // Reads the list, or checks the domains again when `check` is set; `quiet` keeps a failure off the screen.
  const read = (input: { check?: boolean; quiet?: boolean; signal?: AbortSignal } = {}) => {
    const current = ++version

    const call = input.check
      ? rpc().check({}, { ...scope(), signal: input.signal })
      : rpc().list({}, { ...scope(), signal: input.signal })

    return call.then(
      (domains) => {
        if (current !== version || input.signal?.aborted) return
        apply(domains)
      },
      (error: Failure) => {
        if (current !== version || input.signal?.aborted || input.quiet) return
        setState("error", problem(error))
      },
    )
  }

  // Runs one action at a time and shows the list it answers with. Resolves true when it worked, false when it failed or
  // another action was running.
  const act = (action: Action, target: string | undefined, call: () => Promise<Publish.Domains>) => {
    if (state.action) return Promise.resolve(false)
    setState({ action, target, error: undefined })

    return call()
      .then(
        (domains) => {
          apply(domains)

          return true
        },
        (error: Failure) => {
          setState("error", problem(error))

          return false
        },
      )
      .then((done) => {
        setState({ action: undefined, target: undefined })

        return done
      })
  }

  const domains = () => sortDomains(state.domains.domains)
  const pending = () => state.domains.domains.some((domain) => domain.status === "pending")

  // The list, then every change, again whenever the server reconnects or another project is routed.
  createKeyed(
    () => (session().server.connected ? `${session().server.id}\u0000${session().directory}` : undefined),
    () => {
      const controller = new AbortController()
      const signal = controller.signal
      batch(() => {
        setState("domains", reconcile(empty()))
        setState({ loaded: false, error: undefined })
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
      void read({ signal })
    },
  )

  return {
    state,
    loaded: () => state.loaded,
    configured: () => state.domains.configured,
    site: () => state.domains.site,
    subdomain: () => state.domains.subdomain,
    /** The custom domains, the primary first. */
    domains,
    primary: () => state.domains.domains.find((domain) => domain.primary),
    /** The site has as many domains as it can have. */
    full: () => state.domains.domains.length >= LIMIT,
    busy: () => state.action,
    /** Whether the running action is about this hostname. */
    busyWith: (hostname: string) => state.target === hostname,
    error: () => state.error,
    dismissError: () => setState("error", undefined),
    refresh: () => read(),
    /** Adds a domain; `primary` makes it the primary at once. Resolves true when it was added. */
    add: (hostname: string, primary?: boolean) =>
      act("add", undefined, () => rpc().add({ hostname, primary }, scope())),
    /** Adds the www host as the primary, then the apex beside it, which then redirects to it. */
    addWithWww: (pair: { apex: string; www: string }) =>
      act("add", undefined, () =>
        rpc()
          .add({ hostname: pair.www, primary: true }, scope())
          .then(() => rpc().add({ hostname: pair.apex }, scope())),
      ),
    remove: (hostname: string) => act("remove", hostname, () => rpc().remove({ hostname }, scope())),
    setPrimary: (hostname: string) => act("primary", hostname, () => rpc().setPrimary({ hostname }, scope())),
    /** Checks DNS and Cloudflare again for one domain, or for every domain without a hostname. */
    check: (hostname?: string) => act("check", hostname, () => rpc().check({ hostname }, scope())),
    /** The www offer for what the user typed, unless that www host is already connected. */
    suggestion: (input: string) => {
      const offer = suggestion(input)

      if (!offer || state.domains.domains.some((domain) => domain.hostname === offer.www)) return undefined

      return offer
    },
    /**
     * Checks pending domains again every 30 seconds while the calling owner lives; the panel calls it so the checks run
     * only while the Domains tool is on screen. A check never interrupts an action and fails without a message.
     */
    watch: () =>
      createKeyed(
        () => (session().server.connected && pending() ? session().directory : undefined),
        () => {
          const timer = setInterval(() => {
            if (!state.action) void read({ check: true, quiet: true })
          }, RECHECK)

          onCleanup(() => clearInterval(timer))
        },
      ),
  }
}

function empty(): Publish.Domains {
  return { configured: false, domains: [] }
}
