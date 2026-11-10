import { Tabs } from "@opencode/ui/tabs"
import { useDialog } from "@opencode/ui/context/dialog"
import {
  createEffect,
  createMemo,
  createResource,
  For,
  on,
  onCleanup,
  onMount,
  Show,
  Switch,
  Match,
  type Accessor,
} from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/runtime/i18n/language"
import { useTabs } from "@/shell/tabs/tabs"
import { useGlobal, useServerCtx } from "@/runtime/server/runtime"
import { ServerConnection, useServers } from "@/runtime/server/registry"
import { useControlPlaneOptional } from "@/controlplane/session"
import { createPlatformVisibility } from "@/controlplane/platform-models"
import { sharedSettingsTabs } from "@/controlplane/settings-tabs"
import type { LocalProject } from "@/shell/state/layout"
import { DialogServer } from "@/servers/connect/dialog"
import { LocationProvider } from "@/workspaces/location"
import { SettingsGeneral } from "./general/general"
import { SettingsAppearance } from "./appearance/appearance"
import { experimentalSettingsAvailable, SettingsExperimental } from "./experimental/experimental"
import { SettingsKeybinds } from "./keybinds/keybinds"
import { SettingsNotifications } from "./notifications/notifications"
import { SettingsProviders } from "./providers/providers"
import { SettingsModels } from "./models/models"
import { SettingsServerGeneral, SettingsServerList } from "./servers/servers"
import { SettingsServerSwitcher } from "./servers/switcher"
import { SettingsServerNone, SettingsServerUnavailable } from "./servers/unavailable"
import { settingsServerReachable, useSettingsServers, useSettingsServersLoaded } from "./servers/inventory"
import { SettingsExtensions } from "./providers/extensions"
import { SettingsAbout } from "./about/about"
import { SettingsUsers } from "./users/users"
import { restrictions } from "@/controlplane/restrictions"
import { SettingsServerDataScope } from "./server-scope"
import { SettingsNavigation, type SettingsNavGroup } from "./navigation"
import { SettingsProjectGeneral } from "./workspaces/project"
import { ProjectSettingsExtensions } from "./workspaces/project-extensions"
import { useSettingsSurface } from "./surface"
import { settingsViewRedirect } from "./route"
import { pageIcons, pageLabels } from "./pages"
import { revealSettingsSearch } from "./search-reveal"
import { PluginSettingsPages } from "@/runtime/plugin/settings-page-view"
import "@/settings/settings.css"

const rootClientTabs = [
  { value: "general", icon: pageIcons.general, label: "settings.tab.preferences" },
  { value: "appearance", icon: pageIcons.appearance, label: "settings.general.section.appearance" },
  { value: "notifications", icon: pageIcons.notifications, label: "settings.tab.notifications" },
  { value: "shortcuts", icon: pageIcons.shortcuts, label: "settings.tab.shortcuts" },
] as const

const serverTabs = [
  { value: "providers", icon: pageIcons.providers, label: "settings.providers.title" },
  { value: "models", icon: pageIcons.models, label: "settings.models.title" },
  { value: "extensions", icon: pageIcons.extensions, label: "settings.tab.extensions" },
] as const

// The heading of each per-server page, which its unreachable state keeps.
const serverPages = {
  providers: { title: "settings.providers.title", description: "settings.providers.description" },
  models: { title: "settings.models.title", description: "settings.models.description" },
  extensions: { title: "settings.tab.extensions", description: "settings.extensions.description" },
} as const

const experimentalTab = [
  { value: "experimental", icon: pageIcons.experimental, label: "settings.tab.experimental" },
] as const

const aboutTab = [{ value: "about", icon: pageIcons.about, label: "settings.tab.about" }] as const

const nestedProjectTabs = [
  { value: "general", icon: "folder", label: "settings.general.section.general" },
  { value: "extensions", icon: pageIcons.extensions, label: "settings.tab.extensions" },
] as const

export function SettingsScreen() {
  const surface = useSettingsSurface()
  const dialog = useDialog()
  const servers = useSettingsServers()
  const loaded = useSettingsServersLoaded()
  const global = useGlobal()
  let root: HTMLDivElement | undefined
  let viewType = surface.view().type
  let activation = 0

  onMount(() => root?.focus({ preventScroll: true }))
  createEffect(() => {
    const next = surface.view().type

    if (next === viewType) return
    viewType = next
    queueMicrotask(() => {
      const target =
        surface.search.state.query.trim() && surface.search.state.expanded
          ? root?.querySelector<HTMLInputElement>(".settings-search input")
          : root

      target?.focus({ preventScroll: true })
    })
  })

  createEffect(
    on(
      () => [surface.view(), surface.search.state.selected] as const,
      ([view, selected]) => {
        if (
          !root ||
          !selected ||
          !view.searchActivation ||
          view.searchActivation !== surface.search.state.activation ||
          view.searchActivation === activation
        )
          return
        activation = view.searchActivation
        onCleanup(revealSettingsSearch(root, view))
      },
    ),
  )

  const connection = (key: string) => servers().find((item) => item.key === key)

  const project = (server: ServerConnection.Any, directory: string) =>
    global
      .ensureServerCtx(server)
      .projects.list()
      .find((item) => item.worktree === directory)

  const targetServer = createMemo(() => {
    const view = surface.view()

    if (view.type !== "project") return undefined

    return connection(view.server)
  })

  const targetProject = createMemo(() => {
    const view = surface.view()
    const server = targetServer()

    if (view.type !== "project" || !server) return undefined

    return server.connection && project(server.connection, view.project)
  })

  createEffect(() => {
    const next = settingsViewRedirect({
      view: surface.view(),
      loaded: loaded(),
      servers: servers().map((item) => ({
        key: item.key,
        connected: !!item.connection,
        starting: item.source?.entry.state === "starting",
      })),
    })

    if (next) surface.replace(next)
  })

  return (
    <div
      ref={root}
      data-testid="settings-screen"
      class="settings-screen"
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || event.defaultPrevented || dialog.active) return
        event.preventDefault()

        if (surface.view().type !== "root" && surface.search.back()) return

        if (surface.search.state.query.trim()) {
          surface.search.clear()

          return
        }

        surface.back()
      }}
    >
      <Switch>
        <Match when={surface.view().type === "root"}>
          <RootSettings />
        </Match>
        <Match when={surface.view().type === "project"}>
          <Show when={targetServer()?.connection} keyed>
            {(server) => (
              <Show when={targetProject()}>{(project) => <ProjectSettings server={server} project={project()} />}</Show>
            )}
          </Show>
        </Match>
      </Switch>
    </div>
  )
}

function RootSettings() {
  const language = useLanguage()
  const dialog = useDialog()
  const surface = useSettingsSurface()
  const global = useGlobal()
  const inventory = useSettingsServers()
  const platform = usePlatformSettings()

  const [state, setState] = createStore<{ modelProvider: string | undefined }>({ modelProvider: undefined })

  const multiple = createMemo(() => inventory().length > 1)

  // The selected server while its pages can load; an unreachable one shows its pages' unavailable state instead.
  const reachable = createMemo(() => {
    const entry = surface.server()

    return entry && settingsServerReachable(entry, global.servers.health[entry.key]) ? entry.connection : undefined
  })

  const activeDirectory = useSettingsDirectory(reachable)
  createEffect(() => {
    const view = surface.view()

    if (view.type !== "root") return

    if (view.tab === "experimental" && !experimentalSettingsAvailable) surface.open("general")

    // A page an admin hid, or Users & Roles for anyone but an admin, opens Preferences instead.
    if (restrictions.hidden(`settings:${view.tab}`)) surface.open("general")

    if (view.tab === "users" && !platform.tabs().some((tab) => tab === "users")) surface.open("general")
  })

  const selectServer = (server: ServerConnection.Any) => surface.selectServer(ServerConnection.key(server))

  const addServer = () => void dialog.push(() => <DialogServer mode="add" onSave={selectServer} />)

  const pluginTabs = (group?: "about") =>
    surface.plugins
      .pages()
      .filter((item) => item.value.group === group)
      .map((item) => ({ value: item.value.id, icon: item.value.icon ?? pageIcons.extensions, label: item.value.title }))

  // Pages an admin hid from this user leave the navigation.
  const shown = (value: string) => !restrictions.hidden(`settings:${value}`)

  const groups = createMemo<SettingsNavGroup[]>(() => [
    // Multi-user admins first: the providers and models O M A I + offers everyone, and the users they manage.
    ...(platform.tabs().length > 0
      ? [
          {
            label: language.t("settings.group.shared"),
            items: platform
              .tabs()
              .map((value) => ({ value, icon: pageIcons[value], label: language.t(pageLabels[value]) })),
          },
        ]
      : []),
    {
      label: language.t("settings.group.workspace"),
      items: serverTabs.flatMap((item) => (shown(item.value) ? [{ ...item, label: language.t(item.label) }] : [])),
    },
    {
      label: language.t("settings.group.personal"),
      items: [
        ...rootClientTabs.flatMap((item) => (shown(item.value) ? [{ ...item, label: language.t(item.label) }] : [])),
        ...pluginTabs(),
      ],
    },
    {
      label: language.t("settings.group.system"),
      items: [
        ...(shown("servers")
          ? [
              {
                value: "servers",
                icon: pageIcons.servers,
                label: language.t(multiple() ? "settings.tab.servers" : pageLabels.servers),
              },
            ]
          : []),
        ...(experimentalSettingsAvailable
          ? experimentalTab.map((item) => ({ ...item, label: language.t(item.label) }))
          : []),
      ],
    },
    {
      label: language.t("settings.group.more"),
      items: [...aboutTab.map((item) => ({ ...item, label: language.t(item.label) })), ...pluginTabs("about")],
    },
  ])

  return (
    <SettingsNavigation
      value={surface.view().tab}
      groups={groups()}
      backLabel={language.t("settings.backToApp")}
      onBack={() => surface.close()}
      onChange={(value) => surface.select(value)}
    >
      <Tabs.Content value="general" class="settings-panel">
        <SettingsGeneral />
      </Tabs.Content>
      <Tabs.Content value="appearance" class="settings-panel">
        <SettingsAppearance />
      </Tabs.Content>
      <Tabs.Content value="notifications" class="settings-panel">
        <SettingsNotifications />
      </Tabs.Content>
      <Tabs.Content value="shortcuts" class="settings-panel">
        <SettingsKeybinds active={surface.view().tab === "shortcuts"} />
      </Tabs.Content>
      <PluginSettingsPages />
      <Tabs.Content value="experimental" class="settings-panel">
        <SettingsExperimental />
      </Tabs.Content>
      <Tabs.Content value="about" class="settings-panel settings-about">
        <SettingsAbout active={surface.view().tab === "about"} />
      </Tabs.Content>
      <Show
        when={reachable()}
        keyed
        fallback={
          <Show
            when={surface.server()}
            fallback={
              <For each={serverTabs}>
                {(item) => (
                  <Tabs.Content value={item.value} class="settings-panel">
                    <SettingsServerNone
                      title={language.t(serverPages[item.value].title)}
                      description={language.t(serverPages[item.value].description)}
                    />
                  </Tabs.Content>
                )}
              </For>
            }
          >
            {(entry) => (
              <For each={serverTabs}>
                {(item) => (
                  <Tabs.Content value={item.value} class="settings-panel">
                    <SettingsServerUnavailable
                      entry={entry()}
                      title={language.t(serverPages[item.value].title)}
                      description={language.t(serverPages[item.value].description)}
                      headerAction={<SettingsServerSwitcher />}
                      onManage={() => surface.openServers(entry().key)}
                      onServerChange={selectServer}
                    />
                  </Tabs.Content>
                )}
              </For>
            )}
          </Show>
        }
      >
        {(server) => (
          <SettingsServerDataScope server={server}>
            <Tabs.Content value="providers" class="settings-panel">
              <SettingsProviders
                directory={undefined}
                headerAction={<SettingsServerSwitcher />}
                onSelectProvider={(providerID) => {
                  setState("modelProvider", providerID)
                  surface.select("models")
                }}
              />
            </Tabs.Content>
            <Tabs.Content value="models" class="settings-panel">
              <SettingsModels
                active={surface.view().tab === "models"}
                provider={state.modelProvider}
                headerAction={<SettingsServerSwitcher />}
                onReveal={() => setState("modelProvider", undefined)}
              />
            </Tabs.Content>
            <Tabs.Content value="extensions" class="settings-panel">
              <SettingsExtensions
                directory={activeDirectory()}
                subtab={surface.view().subtab}
                headerAction={<SettingsServerSwitcher />}
                onSubtab={(value) => surface.subtab(value)}
              />
            </Tabs.Content>
          </SettingsServerDataScope>
        )}
      </Show>
      {/* Multi-user admins: the shared providers and models every user's projects get. */}
      <Show when={platform.connection()} keyed>
        {(server) => (
          <SettingsServerDataScope server={server} visibility={platform.visibility}>
            <Tabs.Content value="shared-providers" class="settings-panel">
              <SettingsProviders
                directory={undefined}
                onSelectProvider={(providerID) => {
                  setState("modelProvider", providerID)
                  surface.select("shared-models")
                }}
              />
            </Tabs.Content>
            <Tabs.Content value="shared-models" class="settings-panel">
              <SettingsModels
                active={surface.view().tab === "shared-models"}
                provider={state.modelProvider}
                onReveal={() => setState("modelProvider", undefined)}
              />
            </Tabs.Content>
          </SettingsServerDataScope>
        )}
      </Show>
      <Show when={platform.tabs().some((tab) => tab === "users")}>
        <Tabs.Content value="users" class="settings-panel">
          <SettingsUsers />
        </Tabs.Content>
      </Show>
      <Tabs.Content value="servers" class="settings-panel">
        <Show
          when={multiple() ? undefined : inventory()[0]}
          fallback={
            <SettingsServerList
              servers={inventory()}
              selected={surface.server()?.key}
              onAddServer={addServer}
              onServerChange={selectServer}
            />
          }
        >
          {(entry) => <SettingsServerGeneral entry={entry()} onAddServer={addServer} />}
        </Show>
      </Tabs.Content>
    </SettingsNavigation>
  )
}

function ProjectSettings(props: { server: ServerConnection.Any; project: LocalProject }) {
  const language = useLanguage()
  const surface = useSettingsSurface()

  const groups: SettingsNavGroup[] = [
    { items: nestedProjectTabs.map((item) => ({ ...item, label: language.t(item.label) })) },
  ]

  return (
    <SettingsServerDataScope server={props.server} directory={props.project.worktree}>
      <LocationProvider directory={props.project.worktree}>
        <SettingsNavigation
          value={surface.view().tab}
          groups={groups}
          backLabel={language.t("settings.backToProjects")}
          onBack={() => surface.back()}
          onChange={(value) => surface.select(value)}
        >
          <Tabs.Content value="general" class="settings-panel">
            <SettingsProjectGeneral
              server={props.server}
              project={props.project}
              onOpenServer={() => surface.openServers(ServerConnection.key(props.server))}
            />
          </Tabs.Content>
          <Tabs.Content value="extensions" class="settings-panel">
            <ProjectSettingsExtensions subtab={surface.view().subtab} onSubtab={(value) => surface.subtab(value)} />
          </Tabs.Content>
        </SettingsNavigation>
      </LocationProvider>
    </SettingsServerDataScope>
  )
}

function useSettingsDirectory(server: Accessor<ServerConnection.Any | undefined>) {
  const surface = useSettingsSurface()
  const tabs = useTabs()
  const serverCtx = useServerCtx(server)

  return createMemo(() => {
    const current = server()

    if (!current) return undefined
    const key = ServerConnection.key(current)
    const route = surface.route()

    if (route.type === "session" && route.server === key)
      return serverCtx()?.data.session.get(route.sessionId)?.location.directory

    if (route.type !== "draft") return undefined
    const draft = tabs.store.find((item) => item.type === "draft" && item.draftID === route.draftID)

    return draft?.type === "draft" && draft.server === key ? draft.directory : undefined
  })
}

/**
 * Multi-user mode: an admin's Shared providers and Shared models pages work on the platform server (the keys every
 * user's projects get), and the Shared models switches are saved on the control plane. Nobody else sees either page.
 */
function usePlatformSettings() {
  const session = useControlPlaneOptional()
  const servers = useServers()
  const admin = () => session?.state.user?.admin === true

  const [connection] = createResource(
    () => (admin() ? session : undefined),
    async (current) => {
      const opened = await current.client.platform.open()

      return servers.add({
        type: "http",
        http: { url: opened.routerUrl, password: opened.token },
        displayName: "O M A I +",
      })
    },
  )

  return {
    tabs: () => sharedSettingsTabs({ multiUser: session !== undefined, admin: admin() }),
    connection: () => (connection.state === "ready" ? connection() : undefined),
    visibility: session
      ? createPlatformVisibility({
          load: () => (admin() ? session.client.platform.models() : Promise.resolve([])),
          save: (models) => session.client.platform.setModels(models),
        })
      : undefined,
  }
}
