import { ErrorBoundary, createEffect, createMemo, createSignal, onCleanup, Show, type ParentProps } from "solid-js"
import { Title } from "@solidjs/meta"
import { useParams } from "@solidjs/router"
import { createStore } from "solid-js/store"
import { makeEventListener } from "@solid-primitives/event-listener"
import { DataProvider } from "@opencode/session-ui/context"
import { SessionUserMessage } from "@opencode/session-ui/message"
import { TextShimmer } from "@opencode/ui/text-shimmer"
import { isFallbackTitle } from "@opencode/util/session-title-fallback"
import { CommentsProvider } from "@/composer/comments"
import { readPromptPresentation } from "@/composer/comment-note"
import { FileProvider } from "@/workspaces/files/model"
import { LocationProvider } from "@/workspaces/location"
import { ModelsProvider } from "@/providers/models/models"
import { useProviders } from "@/providers/catalog/providers"
import { useLanguage } from "@/runtime/i18n/language"
import { useNotification } from "@/shell/notifications/notification"
import { ComposerPersistenceProvider } from "@/composer/persistence"
import { useData, useServer } from "@/runtime/server/current"
import { ServerConnection } from "@/runtime/server/registry"
import { useSettingsCommand } from "@/settings/command"
import { useSettings } from "@/settings/model"
import { SessionUIProvider } from "@/shell/routes/session-ui-provider"
import { useTabs, type PendingSession } from "@/shell/tabs/tabs"
import { requireServerKey } from "@/shell/routes/session"
import { useSessionModel } from "./model"
import { SessionPanelFrame } from "./session-frame"
import { SessionIdentityHeader } from "./session-identity-header"
import { ServerUnavailablePanel } from "./server-unavailable-panel"
import { SessionErrorFallback } from "./route-error"
import { createSessionResolution } from "./session-resolution"
import { SessionScreenView } from "./screen"
import { PreparingComposer } from "./preparing-composer"
import { BrandLoader } from "@/shell/brand-loader"
import { NetworkRecovery } from "@/shell/network-recovery"
import { isNetworkError } from "@/runtime/network-error"
import { multiUser } from "@/controlplane/client"
import { projectOfConnection } from "@/controlplane/presence"

export function TargetSessionRouteContent() {
  const params = useParams<{ serverKey: string; id: string }>()
  const data = useData()
  const server = useServer()
  const tabs = useTabs()
  const directory = createMemo(() => data.session.get(params.id)?.location.directory)

  return (
    <>
      <MarkSessionViewed sessionID={() => params.id} />
      <SessionDocumentTitle sessionID={() => params.id} />
      <ModelsProvider directory={directory()}>
        <TargetSessionSettingsCommand />
        <SessionRouteErrorBoundary sessionID={params.id} serverKey={requireServerKey(params.serverKey)}>
          <Show when={tabs.pendingSession(server.key, params.id)} fallback={<ResolvedTargetSessionRoute />}>
            {(pending) => <PreparingSession sessionID={params.id} pending={pending()} />}
          </Show>
        </SessionRouteErrorBoundary>
      </ModelsProvider>
    </>
  )
}

function PreparingSession(props: { sessionID: string; pending: PendingSession }) {
  const language = useLanguage()
  const providers = useProviders(() => props.pending.draft.directory)
  const settings = useSettings()

  return (
    <SessionStatePanel>
      <DataProvider
        directory={props.pending.draft.directory}
        agents={settings.visibility.customAgents()}
        data={{
          session: [],
          session_status: {},
          session_diff: {},
          provider: { all: providers.all(), default: providers.default(), connected: [] },
        }}
      >
        <div data-component="session-preparing" class="min-h-0 flex-1 overflow-y-auto">
          <SessionIdentityHeader sessionID={props.sessionID} />
          <div class="mx-auto w-full min-w-0 px-4 pb-5 md:max-w-session md:px-6">
            <SessionUserMessage
              sessionID={props.sessionID}
              message={props.pending.message}
              comments={readPromptPresentation(props.pending.message.metadata)?.comments}
              historicalAgent={props.pending.selection.agent}
              historicalModel={{
                id: props.pending.selection.model.modelID,
                providerID: props.pending.selection.model.providerID,
                variant: props.pending.selection.variant,
              }}
            />
            <div
              role="status"
              class="mt-3 flex min-h-6 items-center text-[13px] font-medium leading-[var(--line-height-compact)] text-v2-text-text-muted"
            >
              <TextShimmer text={language.t("session.new.worktree.creating")} active />
            </div>
          </div>
        </div>
        <PreparingComposer pending={props.pending} />
      </DataProvider>
    </SessionStatePanel>
  )
}

function TargetSessionSettingsCommand() {
  useSettingsCommand()

  return null
}

function SessionRouteErrorBoundary(props: ParentProps<{ sessionID?: string; serverKey?: ServerConnection.Key }>) {
  return (
    <ErrorBoundary
      fallback={(error, reset) => (
        <SessionStatePanel>
          {/* A request that failed in transit passes once the network is back: wait it out instead of an error. */}
          <Show
            when={isNetworkError(error)}
            fallback={<SessionErrorFallback error={error} sessionID={props.sessionID} serverKey={props.serverKey} />}
          >
            <NetworkRecovery reset={reset} />
          </Show>
        </SessionStatePanel>
      )}
    >
      {props.children}
    </ErrorBoundary>
  )
}

function ResolvedTargetSessionRoute() {
  const params = useParams<{ id: string }>()
  const server = useServer()
  const tabs = useTabs()
  const data = useData()

  const current = createSessionResolution(
    () => params.id,
    () => data.session,
    { children: true, connected: () => server.ctx.sdk.connection.status() === "connected" },
  )

  const directory = createMemo(() => current()?.location.directory)

  // Only a failed health check: a version mismatch has its own panel, and a rejected credential is not an outage.
  const unreachable = () => {
    const health = server.health

    return !!health && !health.healthy && !health.checking && !health.unauthorized && !health.incompatible
  }

  // A project VM that paused is unreachable while it starts again, which takes a while; the health check that keeps
  // asking wakes it. Until it has been down for a few minutes that is starting, not an outage.
  const project = () => !!multiUser() && server.conn.type === "http" && !!projectOfConnection(server.conn.http.url)
  const [stuck, setStuck] = createSignal(false)

  createEffect(() => {
    if (!project() || !unreachable()) return setStuck(false)

    const timer = setTimeout(() => setStuck(true), 180_000)

    onCleanup(() => clearTimeout(timer))
  })

  return (
    <Show
      when={!server.health?.incompatible}
      fallback={
        <SessionStatePanel>
          <ServerUnavailablePanel
            reason="incompatible"
            onClose={() => tabs.removeSessionTab({ server: server.key, sessionId: params.id })}
          />
        </SessionStatePanel>
      }
    >
      <Show
        when={directory()}
        fallback={
          // Nothing is cached and an unreachable server never resolves the session, so explain instead of waiting blank.
          <Show
            when={unreachable() && (!project() || stuck())}
            fallback={<PendingSessionState sessionID={params.id} starting={!!project() && unreachable()} />}
          >
            <SessionStatePanel>
              <ServerUnavailablePanel
                reason="unreachable"
                onClose={() => tabs.removeSessionTab({ server: server.key, sessionId: params.id })}
              />
            </SessionStatePanel>
          </Show>
        }
      >
        {(value) => (
          <LocationProvider directory={value()}>
            <SessionUIProvider directory={value()} server={server.key}>
              <TargetSessionPage />
            </SessionUIProvider>
          </LocationProvider>
        )}
      </Show>
    </Show>
  )
}

function PendingSessionState(props: { sessionID: string; starting?: boolean }) {
  const language = useLanguage()

  return (
    <SessionStatePanel>
      <SessionIdentityHeader sessionID={props.sessionID} />
      <div class="relative flex min-h-0 flex-1 flex-col">
        <BrandLoader />
        {/* Just under the centered icon, without moving it. */}
        <Show when={props.starting}>
          <div class="absolute start-1/2 top-[calc(50%+52px)] flex w-[min(340px,calc(100%-48px))] -translate-x-1/2 flex-col items-center gap-1 text-center rtl:translate-x-1/2">
            <span class="text-[14px] font-[500] text-v2-text-text-base">{language.t("session.starting.title")}</span>
            <span class="text-[12px] text-v2-text-text-muted">{language.t("session.starting.description")}</span>
          </div>
        </Show>
      </div>
    </SessionStatePanel>
  )
}

function SessionStatePanel(props: ParentProps) {
  return (
    <div class="flex min-h-0 flex-1 px-[var(--shell-inline-inset,8px)] pb-[var(--shell-bottom-inset,8px)] pt-[var(--shell-top-inset,8px)]">
      <SessionPanelFrame raised>{props.children}</SessionPanelFrame>
    </div>
  )
}

function TargetSessionPage() {
  return (
    // These providers select their scoped state reactively and retain bounded caches,
    // so keep their owners alive while navigating between workspaces on this server.
    <FileProvider>
      <ComposerPersistenceProvider>
        <CommentsProvider>
          <SessionPage />
        </CommentsProvider>
      </ComposerPersistenceProvider>
    </FileProvider>
  )
}

function SessionPage() {
  const session = useSessionModel()

  return <SessionScreenView session={session} />
}

function MarkSessionViewed(props: { sessionID: () => string | undefined }) {
  const notification = useNotification()
  const [focus, setFocus] = createStore({ window: document.hasFocus() })
  const update = () => setFocus("window", document.hasFocus())
  makeEventListener(window, "focus", update)
  makeEventListener(window, "blur", update)
  makeEventListener(document, "visibilitychange", update)

  // Viewed state is shared by every client, so only a focused window reports what its user has seen.
  // markViewed reads the session's idle watermark, so a turn finishing while it stays open re-runs this.
  createEffect(() => {
    const sessionID = props.sessionID()

    if (!sessionID || !focus.window) return
    notification.session.markViewed(sessionID)
  })

  return null
}

// Browser tabs and desktop windows are otherwise indistinguishable, so name them after the open session.
function SessionDocumentTitle(props: { sessionID: () => string }) {
  const data = useData()

  const title = createMemo(() => {
    const value = data.session.get(props.sessionID())?.title

    return isFallbackTitle(value) ? undefined : value
  })

  // Keyed: <Title> reads its text inside a meta effect, which would hit a stale Show accessor once the session is deleted.
  return (
    <Show when={title()} keyed>
      {(value) => <Title>{`${value} · O M A I +`}</Title>}
    </Show>
  )
}
