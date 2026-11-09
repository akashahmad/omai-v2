import { Route, useParams } from "@solidjs/router"
import { createMemo, lazy, Show, Suspense, type ParentProps } from "solid-js"
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
import { requireServerKey } from "./session"
import { PluginAttachment } from "@/runtime/plugin/root"
import { multiUser } from "@/controlplane/client"
import { ControlPlaneRoot, RequireSignedIn } from "@/controlplane/session"

export const File = lazy(() => import("@opencode/session-ui/file").then((module) => ({ default: module.File })))

const loadSessionRoute = () => Promise.all([import("@/session/route"), File.preload()]).then(([module]) => module)

const DraftRoute = lazy(() => import("@/new-session/route").then((module) => ({ default: module.DraftRoute })))

const SettingsScreen = lazy(() => import("@/settings/shell").then((module) => ({ default: module.SettingsScreen })))

const LoginPage = lazy(() => import("@/controlplane/login").then((module) => ({ default: module.LoginPage })))

const SignupPage = lazy(() => import("@/controlplane/signup").then((module) => ({ default: module.SignupPage })))

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

  const connection = createMemo(() =>
    global.servers.list().find((item) => ServerConnection.key(item) === requireServerKey(params.serverKey)),
  )

  return (
    <Show when={connection()} keyed>
      {(connection) => <ServerProvider conn={connection}>{props.children}</ServerProvider>}
    </Show>
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
