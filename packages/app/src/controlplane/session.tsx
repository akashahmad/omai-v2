import { Navigate, useLocation, useNavigate } from "@solidjs/router"
import { createContext, createEffect, Match, onCleanup, onMount, type ParentProps, Switch, useContext } from "solid-js"
import { createStore } from "solid-js/store"
import { ServerConnection, useServers } from "@/runtime/server/registry"
import { BrandLoader } from "@/shell/brand-loader"
import { ControlPlaneClient, multiUser, type User } from "./client"
import { requireServerKey } from "@/shell/routes/session"
import { createIdleLogout } from "./idle"
import { createPresence, projectOfConnection } from "./presence"
import { applyRestrictions } from "./restrictions"
import { setProjectTokenRefresh } from "./project-token"
import { PLATFORM_PROJECT } from "./platform"

const IDLE_MS = Number(import.meta.env.VITE_OMAI_SESSION_IDLE_MS) || 900_000

const CHANNEL = "omai-session"

type State = { status: "checking" | "in" | "out"; user?: User; signupEnabled: boolean }

function createSession(apiUrl: string) {
  const client = ControlPlaneClient.make(apiUrl)
  const servers = useServers()
  const navigate = useNavigate()
  const location = useLocation()
  const [state, setState] = createStore<State>({ status: "checking", signupEnabled: false })
  const channel = new BroadcastChannel(CHANNEL)

  // Every stored connection in multi-user mode is a project VM opened with this user's token; none may outlive
  // the session or be seen by the next person to sign in on this browser.
  const forgetProjects = () => {
    for (const conn of servers.list) if (conn.type === "http") servers.remove(ServerConnection.key(conn))
  }

  const signedOut = () => {
    forgetProjects()
    applyRestrictions(undefined)
    setState({ status: "out", user: undefined })

    if (location.pathname === "/login" || location.pathname === "/signup" || location.pathname.startsWith("/share/"))
      return
    navigate(`/login?next=${encodeURIComponent(location.pathname + location.search)}`, { replace: true })
  }

  client.onSignedOut(signedOut)
  // An admin's change to this user arrives with the next token refresh, within minutes, without signing in again.
  client.onUser((user) => {
    applyRestrictions(user)

    if (state.status === "in") setState("user", user)
  })
  channel.addEventListener("message", (event: MessageEvent) => {
    if (event.data?.type === "logout") signedOut()
  })

  onMount(() => {
    void client.config().then(
      (config) => setState("signupEnabled", config.signupEnabled),
      () => undefined,
    )
    void client.refresh().then((user) => {
      if (user) setState({ status: "in", user })
    })
  })

  // Idle logout runs only while signed in.
  createEffect(() => {
    if (state.status !== "in") return

    const dispose = createIdleLogout({
      timeoutMs: IDLE_MS,
      channel: new BroadcastChannel(`${CHANNEL}-activity`),
      onActive: () => void client.ping().catch(() => undefined),
      onIdle: () => void logout(),
    })

    onCleanup(dispose)
  })

  // A project connection whose VM token stopped working gets a fresh one, while signed in.
  createEffect(() => {
    if (state.status !== "in") return

    onCleanup(
      setProjectTokenRefresh(async (url) => {
        const projectID = projectOfConnection(url)

        if (!projectID) return undefined

        // The platform server behind an admin's Shared providers and Shared models is opened on its own route.
        const opened =
          projectID === PLATFORM_PROJECT ? await client.platform.open() : await client.projects.open(projectID)

        if (opened === "not-ready") return undefined
        const stored = servers.list.find((conn) => conn.type === "http" && conn.http.url === url)
        const http = { url: opened.routerUrl, password: opened.token }

        // The stored connection keeps the token too, for uploads and anything else that reads it.
        if (stored?.type === "http") servers.add({ ...stored, http })

        return http
      }),
    )
  })

  // The open project's VM stays awake while its tab is in use.
  createEffect(() => {
    if (state.status !== "in") return

    const dispose = createPresence({
      projectID: () => {
        const segment = /^\/server\/([^/]+)\/session\//.exec(location.pathname)?.[1]

        if (!segment) return undefined
        const key = requireServerKey(segment)
        const conn = servers.list.find((item) => ServerConnection.key(item) === key)

        return conn?.type === "http" ? projectOfConnection(conn.http.url) : undefined
      },
      send: (id) => void client.projects.presence(id).catch(() => undefined),
    })

    onCleanup(dispose)
  })

  onCleanup(() => channel.close())

  async function logout() {
    await client.logout()
    channel.postMessage({ type: "logout" })
    signedOut()
  }

  return {
    client,
    state,
    logout,
    /** After login or signup: start from a clean slate of project connections. */
    signedIn(user: User) {
      forgetProjects()
      setState({ status: "in", user })
    },
  }
}

export type ControlPlaneSession = ReturnType<typeof createSession>

const Context = createContext<ControlPlaneSession>()

export function useControlPlane() {
  const value = useContext(Context)

  if (!value) throw new Error("useControlPlane used outside multi-user mode")

  return value
}

/** The session in multi-user mode, undefined otherwise. */
export function useControlPlaneOptional() {
  return useContext(Context)
}

/** Route wrapper for multi-user mode: owns the control plane client, the session and idle logout. */
export function ControlPlaneRoot(props: ParentProps) {
  const session = createSession(multiUser()!)

  return <Context.Provider value={session}>{props.children}</Context.Provider>
}

/** Sends signed-out visitors to the login page, remembering where they were going. */
export function RequireSignedIn(props: ParentProps) {
  const session = useControlPlane()
  const location = useLocation()

  return (
    <Switch>
      <Match when={session.state.status === "checking"}>
        <div class="flex h-dvh w-full">
          <BrandLoader />
        </div>
      </Match>
      <Match when={session.state.status === "out"}>
        <Navigate href={`/login?next=${encodeURIComponent(location.pathname + location.search)}`} />
      </Match>
      <Match when={session.state.status === "in"}>{props.children}</Match>
    </Switch>
  )
}

/** Only same-app paths are followed after login. */
export function safeNext(next: string | undefined | null) {
  if (!next || !next.startsWith("/") || next.startsWith("//")) return "/"

  return next
}
