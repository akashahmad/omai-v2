import { Route, useLocation, useNavigate, useParams } from "@solidjs/router"
import { createMemo, createResource, lazy, Show, Suspense, type ParentProps } from "solid-js"
import { Home } from "@/home/route"
import { ProjectsLanding } from "@/projects/landing"
import { AllProjects } from "@/projects/all"
import { ServerProvider } from "@/runtime/server/current"
import { useGlobal } from "@/runtime/server/runtime"
import { ServerConnection, useServers } from "@/runtime/server/registry"
import { SessionPanelFrame, SessionRouteFrame } from "@/session/session-frame"
import { BrandLoader } from "@/shell/brand-loader"
import { LayoutProvider } from "@/shell/state/layout"
import { SettingsSurfaceProvider } from "@/settings/surface"
import Shell from "@/shell/shell"
import { base64Encode } from "@opencode/util/encode"
import { decode64 } from "@/runtime/persistence/base64"
import { useLanguage } from "@/runtime/i18n/language"
import { BrandIcon } from "@/shell/brand-icon"
import { projectOfConnection } from "@/controlplane/presence"
import { PluginAttachment } from "@/runtime/plugin/root"
import { multiUser } from "@/controlplane/client"
import { ControlPlaneRoot, RequireSignedIn, useControlPlaneOptional } from "@/controlplane/session"

export const File = lazy(() => import("@opencode/session-ui/file").then((module) => ({ default: module.File })))

const loadSessionRoute = () => Promise.all([import("@/session/route"), File.preload()]).then(([module]) => module)

const DraftRoute = lazy(() => import("@/new-session/route").then((module) => ({ default: module.DraftRoute })))

const SettingsScreen = lazy(() => import("@/settings/shell").then((module) => ({ default: module.SettingsScreen })))

const LoginPage = lazy(() => import("@/controlplane/login").then((module) => ({ default: module.LoginPage })))

const SignupPage = lazy(() => import("@/controlplane/signup").then((module) => ({ default: module.SignupPage })))

const SharePage = lazy(() => import("@/session/share/page").then((module) => ({ default: module.SharePage })))

const ConnectServerScreen = lazy(() =>
  import("@/servers/connect/screen").then((module) => ({ default: module.ConnectServerScreen })),
)

const TargetSessionRouteContent = lazy(() =>
  loadSessionRoute().then((module) => ({ default: module.TargetSessionRouteContent })),
)

export function preloadRoute(url: string) {
  const pathname = url.split(/[?#]/, 1)[0]

  if (pathname === "/new-session") return DraftRoute.preload().then(() => undefined)

  if (pathname === "/settings") return SettingsScreen.preload().then(() => undefined)

  if (/^\/server\/[^/]+\/session\/[^/]+$/.test(pathname))
    return TargetSessionRouteContent.preload().then(() => undefined)

  return Promise.resolve()
}

export function AppRoutes() {
  if (multiUser()) return <MultiUserRoutes />

  return <Route component={AppLayout}>{appPages()}</Route>
}

function appPages() {
  return (
    <>
      <Route path="/" component={ProjectsLanding} />
      <Route path="/projects" component={AllProjects} />
      <Route path="/sessions" component={Home} />
      <Route path="/settings" component={SettingsRoute} />
      <Route path="/server/:serverKey/session/:id" component={SessionRoute} />
      <Route path="/new-session" component={DraftRoute} />
    </>
  )
}

/**
 * Multi-user mode: login and signup are public; every other page is the usual app, behind a session. Projects come
 * from the control plane, and each opened project is its own server connection.
 */
function MultiUserRoutes() {
  return (
    <Route component={ControlPlaneRoot}>
      <Route path="/login" component={LoginPage} />
      <Route path="/signup" component={SignupPage} />
      {/* A shared conversation is public: anyone with the link reads it, signed in or not. */}
      <Route path="/share/:id" component={SharePage} />
      <Route component={RequireSignedIn}>
        <Route component={AppLayout}>{appPages()}</Route>
      </Route>
    </Route>
  )
}

// A new boundary, so the loader shows at once instead of the old page staying up while Settings downloads.
function SettingsRoute() {
  return (
    <Suspense fallback={<BrandLoader />}>
      <SettingsScreen />
    </Suspense>
  )
}

function SessionRoute() {
  return (
    <SessionRouteFrame>
      <Suspense
        fallback={
          <div class="flex min-h-0 flex-1 px-[var(--shell-inline-inset,8px)] pb-[var(--shell-bottom-inset,8px)] pt-[var(--shell-top-inset,8px)]">
            <SessionPanelFrame raised>
              <BrandLoader />
            </SessionPanelFrame>
          </div>
        }
      >
        <TargetServerRoute>
          <TargetSessionRouteContent />
        </TargetServerRoute>
      </Suspense>
    </SessionRouteFrame>
  )
}

function TargetServerRoute(props: ParentProps) {
  const params = useParams<{ serverKey: string }>()
  const global = useGlobal()
  const servers = useServers()
  const session = useControlPlaneOptional()
  const navigate = useNavigate()
  const location = useLocation()

  const key = createMemo(() => serverKeyOf(params.serverKey))

  const connection = createMemo(() => global.servers.list().find((item) => ServerConnection.key(item) === key()))

  // A link to a project this browser hasn't opened (a new window, cleared storage, someone else's link): the control
  // plane opens it when it is the user's, and says no otherwise. Anything else ends on a page that says so.
  const [reopened, { refetch }] = createResource(
    () => (connection() ? undefined : (key() ?? "invalid")),
    async (wanted) => {
      const projectID =
        wanted !== "invalid" && session && URL.canParse(wanted) ? projectOfConnection(wanted) : undefined

      if (!projectID || !session) return "unavailable" as const
      const project = await session.client.projects.get(projectID).catch(() => undefined)

      if (!project) return "unavailable" as const
      const opened = await session.client.projects.open(projectID).catch(() => undefined)

      // Its VM is still being created: look again shortly.
      if (opened === "not-ready") {
        setTimeout(() => void refetch(), 3000)

        return "starting" as const
      }

      if (!opened) return "unavailable" as const

      const added = servers.add({
        type: "http",
        http: { url: opened.routerUrl, password: opened.token },
        displayName: project.name,
      })

      // The project now answers at another address: follow it, keeping the rest of the path.
      if (added && ServerConnection.key(added) !== wanted)
        navigate(location.pathname.replace(params.serverKey, base64Encode(ServerConnection.key(added))), {
          replace: true,
        })

      return added ? ("opened" as const) : ("unavailable" as const)
    },
  )

  return (
    <Show
      when={connection()}
      keyed
      fallback={
        <Show when={reopened() === "unavailable"} fallback={<BrandLoader />}>
          <ProjectUnavailable />
        </Show>
      }
    >
      {(connection) => <ServerProvider conn={connection}>{props.children}</ServerProvider>}
    </Show>
  )
}

// The route's server key, or undefined when the address is not one this app wrote.
function serverKeyOf(segment: string) {
  const key = decode64(segment)

  return key && base64Encode(key) === segment ? ServerConnection.Key.make(key) : undefined
}

/** A project link that doesn't open: it doesn't exist, it was deleted, or it belongs to someone else. */
function ProjectUnavailable() {
  const language = useLanguage()
  const navigate = useNavigate()

  return (
    <div class="flex min-h-0 flex-1 px-[var(--shell-inline-inset,8px)] pb-[var(--shell-bottom-inset,8px)] pt-[var(--shell-top-inset,8px)]">
      <SessionPanelFrame raised>
        <div class="flex h-full flex-col items-center justify-center gap-4 px-6 text-center">
          <BrandIcon class="size-14 rounded-[12px] opacity-60" />
          <div class="flex max-w-[380px] flex-col gap-1.5">
            <h1 class="text-[18px] font-[600] text-v2-text-text-base">{language.t("project.unavailable.title")}</h1>
            <p class="text-[13px] leading-[20px] text-v2-text-text-muted">
              {language.t("project.unavailable.description")}
            </p>
          </div>
          <button
            type="button"
            class="flex h-9 cursor-pointer items-center gap-2 rounded-[8px] bg-[#0a3a78] px-4 text-[13px] font-[600] text-[#fff] hover:bg-[#082f62]"
            onClick={() => navigate("/", { replace: true })}
          >
            {language.t("project.unavailable.back")}
          </button>
        </div>
      </SessionPanelFrame>
    </div>
  )
}

function AppLayout(props: ParentProps) {
  const servers = useServers()
  const global = useGlobal()

  // A lone server that rejects our credentials (e.g. the web app before pairing) has nothing else to show.
  const signedOut = () => {
    const only = servers.list.length === 1 ? servers.list[0] : undefined

    if (only?.type !== "http") return

    return global.servers.health[ServerConnection.key(only)]?.unauthorized ? only : undefined
  }

  // In multi-user mode there is no server to connect to by hand: the shell shows even before a project is opened.
  if (multiUser())
    return (
      <LayoutProvider>
        <SettingsSurfaceProvider>
          <PluginAttachment>
            <Shell>{props.children}</Shell>
          </PluginAttachment>
        </SettingsSurfaceProvider>
      </LayoutProvider>
    )

  return (
    <Show when={servers.list.length > 0 && !signedOut()} fallback={<ConnectServerScreen url={signedOut()?.http.url} />}>
      <LayoutProvider>
        <SettingsSurfaceProvider>
          <PluginAttachment>
            <Shell>{props.children}</Shell>
          </PluginAttachment>
        </SettingsSurfaceProvider>
      </LayoutProvider>
    </Show>
  )
}
