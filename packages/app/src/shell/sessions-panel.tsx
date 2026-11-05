import { createMemo, createResource, createSignal, For, Show } from "solid-js"
import { ActivityRing } from "@opencode/ui/activity-ring"
import { Icon } from "@opencode/ui/icon"
import { Tooltip } from "@opencode/ui/tooltip"
import {
  displayName,
  getProjectAvatarGenerated,
  getProjectAvatarSource,
  getProjectAvatarVariant,
  ProjectAvatar,
} from "@opencode/ui/project-avatar"
import { useLanguage } from "@/runtime/i18n/language"
import { ServerConnection } from "@/runtime/server/registry"
import { useGlobal } from "@/runtime/server/runtime"
import { errorMessage } from "@/shell/layout/helpers"
import { useSessionTabAvatarState } from "@/shell/layout/project-avatar-state"
import { showToast } from "@/shell/notifications/toast"
import { useLayout } from "@/shell/state/layout"
import { useTabs } from "@/shell/tabs/tabs"
import { getRelativeTime } from "@/shell/time"

/**
 * The routed session's project: its sessions, newest first, and opening, stepping through or starting one. Created
 * once by the shell, which hands it to the rail and the sessions panel so they share one list.
 */
export function createOpenProject() {
  const language = useLanguage()
  const layout = useLayout()
  const global = useGlobal()
  const tabs = useTabs()
  const [creating, setCreating] = createSignal(false)

  const current = createMemo(() => {
    const route = layout.route()

    if (route.type !== "session") return
    const conn = global.servers.list().find((item) => ServerConnection.key(item) === route.server)

    if (!conn) return
    const ctx = global.ensureServerCtx(conn)
    const info = ctx.data.session.get(route.sessionId)

    if (!info) return

    return {
      conn,
      ctx,
      sessionID: route.sessionId,
      directory: info.location.directory,
      project: ctx.projects.forSession(info),
    }
  })

  const open = (sessionID: string) => {
    const value = current()

    if (!value) return
    tabs.select(tabs.addSessionTab({ server: ServerConnection.key(value.conn), sessionId: sessionID }))
  }

  const create = async () => {
    const value = current()

    if (!value || creating()) return
    setCreating(true)

    try {
      const session = await value.ctx.data.session.create({
        location: { directory: value.project?.worktree ?? value.directory },
        projectID: value.project?.id,
      }).request

      value.ctx.data.session.remember(session)
      open(session.id)
    } catch (cause) {
      showToast({
        title: language.t("common.requestFailed"),
        description: errorMessage(cause, language.t("common.requestFailed")),
      })
    } finally {
      setCreating(false)
    }
  }

  // Reloads as the routed session changes, so a session made elsewhere shows up when it opens.
  const [sessions] = createResource(
    () => {
      const value = current()

      return value && { ...value, key: `${value.project?.id ?? value.directory}\n${value.sessionID}` }
    },
    async (value) =>
      (
        await value.ctx.sdk.api.session.list({
          ...(value.project?.id ? { project: value.project.id } : { directory: value.directory }),
          parentID: null,
          archived: false,
          order: "desc",
          limit: 100,
        })
      ).data,
  )

  // `latest` suspends until the first page lands, so it is read only once loaded.
  const list = () => (sessions.state === "ready" || sessions.state === "refreshing" ? (sessions.latest ?? []) : [])

  // The session `offset` places from the routed one in the newest-first list: 1 is older, -1 newer.
  const neighbour = (offset: number) => {
    const id = current()?.sessionID
    const index = list().findIndex((session) => session.id === id)

    return index === -1 ? undefined : list()[index + offset]
  }

  return {
    current,
    creating,
    list,
    loading: () => sessions.loading,
    open,
    create,
    neighbour,
    step: (offset: number) => {
      const target = neighbour(offset)

      if (target) open(target.id)
    },
  }
}

export type OpenProject = ReturnType<typeof createOpenProject>

/** The sessions of the routed session's project, newest first: the contents of the card beside the rail. */
export function SessionsPanel(props: { project: OpenProject }) {
  const language = useLanguage()
  const current = props.project.current
  const creating = props.project.creating
  const open = props.project.open
  const create = props.project.create

  return (
    <div data-component="sessions-panel" class="flex h-full flex-col px-1.5">
      <Show when={current()}>
        {(value) => (
          <>
            <div class="flex h-12 shrink-0 items-center gap-2 ps-2 pe-1">
              <Show when={value().project}>
                {(project) => (
                  <ProjectAvatar
                    class="shrink-0"
                    fallback={displayName(project())}
                    src={getProjectAvatarSource(project().id, project().icon)}
                    variant={getProjectAvatarVariant(project().icon?.color)}
                    generated={getProjectAvatarGenerated(project())}
                  />
                )}
              </Show>
              <span class="min-w-0 flex-1 truncate text-14-medium text-v2-text-text-base">
                {displayName(value().project ?? { worktree: value().directory })}
              </span>
              <Tooltip placement="bottom" value={language.t("command.session.new")}>
                <button
                  type="button"
                  data-action="sessions-panel-new"
                  aria-label={language.t("command.session.new")}
                  disabled={creating()}
                  class="flex size-7 shrink-0 items-center justify-center rounded-[6px] text-v2-icon-icon-muted hover:bg-v2-overlay-simple-overlay-hover hover:text-v2-icon-icon-base focus-visible:bg-v2-overlay-simple-overlay-hover focus-visible:outline-none disabled:opacity-40"
                  onClick={() => void create()}
                >
                  <Icon name="plus" />
                </button>
              </Tooltip>
            </div>
            <div class="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto">
              <For
                each={props.project.list()}
                fallback={
                  <Show when={!props.project.loading()}>
                    <div class="px-2 py-1.5 text-13-regular text-v2-text-text-faint">
                      {language.t("rail.sessions.empty")}
                    </div>
                  </Show>
                }
              >
                {(session) => {
                  // The data cache follows renames and activity the listed page has not seen.
                  const info = () => value().ctx.data.session.get(session.id) ?? session

                  // The tabs' busy check: the session or any of its children working, unless it waits on the user.
                  const state = useSessionTabAvatarState(
                    () => ServerConnection.key(value().conn),
                    () => session.id,
                    () => true,
                  )

                  return (
                    <button
                      type="button"
                      data-action="sessions-panel-open"
                      aria-current={session.id === value().sessionID ? "page" : undefined}
                      class="flex h-8 w-full shrink-0 items-center gap-2 rounded-[6px] px-2 text-start text-13-regular text-v2-text-text-muted hover:bg-v2-overlay-simple-overlay-hover hover:text-v2-text-text-base focus-visible:bg-v2-overlay-simple-overlay-hover focus-visible:outline-none aria-[current=page]:bg-v2-background-bg-layer-02 aria-[current=page]:text-v2-text-text-base"
                      onClick={() => open(session.id)}
                    >
                      <Show when={state.loading()}>
                        <ActivityRing data-slot="sessions-panel-busy" class="shrink-0 text-v2-icon-icon-muted" />
                      </Show>
                      <span class="min-w-0 flex-1 truncate" dir="auto">
                        {info().title || language.t("session.tab.session")}
                      </span>
                      <span class="shrink-0 text-12-regular text-v2-text-text-faint">
                        {getRelativeTime(new Date(info().time.updated).toISOString(), language.t)}
                      </span>
                    </button>
                  )
                }}
              </For>
            </div>
          </>
        )}
      </Show>
    </div>
  )
}
