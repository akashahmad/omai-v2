import { Show, startTransition, Suspense, type ParentProps } from "solid-js"
import { createMediaQuery } from "@solid-primitives/media"
import { useDialog } from "@opencode/ui/context/dialog"
import { Titlebar } from "@/shell/titlebar/titlebar"
import { usePlatform } from "@/runtime/platform/platform"
import { ToastRegion } from "@/shell/notifications/toast"
import { UploadToastHost } from "@/composer/attachments/uploads"
import { useSettingsSurface } from "@/settings/surface"
import { useSettings } from "@/settings/model"
import { PluginServerCover } from "@/runtime/plugin/server-shell"
import { PluginSlot } from "@/runtime/plugin/render"
import { COMMAND_SEARCH_ID, useCommand } from "@/shell/commands/command"
import { useLanguage } from "@/runtime/i18n/language"
import { useGlobal } from "@/runtime/server/runtime"
import { useServers } from "@/runtime/server/registry"
import { useTabs } from "@/shell/tabs/tabs"
import { windowDragEnabled } from "@/session/header/drag-area"
import { useLayout } from "@/shell/state/layout"
import { Rail } from "@/shell/rail"
import { EdgePanel } from "@/shell/edge-panel"
import { createOpenProject, SessionsPanel } from "@/shell/sessions-panel"

export const sidebarToggleCommand = { id: "sidebar.toggle", keybind: "mod+shift+b" }

export default function Layout(props: ParentProps) {
  const platform = usePlatform()
  const settings = useSettingsSurface()
  const preferences = useSettings()
  const command = useCommand()
  const language = useLanguage()
  const dialog = useDialog()
  const global = useGlobal()
  const servers = useServers()
  const tabs = useTabs()
  const mobile = createMediaQuery("(max-width: 767px)")

  const layout = useLayout()
  const project = createOpenProject()

  // Wide screens keep the rail; the titlebar there only hosts its commands.
  const rail = () => !mobile()
  const sessionsPanel = () => rail() && layout.route().type === "session" && preferences.appearance.sidebarOpen()
  // The right panel's full view takes the whole window, the rail and the sessions list included.
  const fullView = () => layout.route().type === "session" && preferences.appearance.sidePanelExpanded()

  const toggleSidebar = () => preferences.appearance.setSidebarOpen(!preferences.appearance.sidebarOpen())

  command.register("sidebar", () =>
    rail()
      ? [
          {
            ...sidebarToggleCommand,
            title: language.t("command.sidebar.toggle"),
            category: language.t("command.category.view"),
            onSelect: toggleSidebar,
          },
        ]
      : [],
  )
  // Every surface has a palette: routes with their own register under the same key, and the newest wins.
  command.register("palette", () => [
    {
      id: "command.palette",
      title: language.t("command.palette"),
      hidden: true,
      onSelect: async () => {
        const conn = servers.visible.find((item) => servers.current(item)) ?? servers.visible[0]

        if (!conn) return
        const { HomeCommandPalette } = await import("@/home/start/command-palette")
        void dialog.show(() => (
          <HomeCommandPalette
            server={conn}
            onSelectSession={(entry) => {
              if (!entry.sessionID || !entry.directory || !entry.server) return
              const sessionID = entry.sessionID
              const server = entry.server
              global.ensureServerCtx(conn).projects.touch(entry.project?.worktree ?? entry.directory)
              void startTransition(() => {
                tabs.select(tabs.addSessionTab({ server, sessionId: sessionID }))
              })
            }}
          />
        ))
      },
    },
  ])
  command.register("commands", () => [
    {
      id: COMMAND_SEARCH_ID,
      title: language.t("command.commands.search"),
      category: language.t("command.category.view"),
      onSelect: async () => {
        const { DialogCommandSearch } = await import("@/shell/commands/command-search")
        void dialog.show(() => <DialogCommandSearch />)
      },
    },
  ])
  const bottomTitlebar = () => mobile() && preferences.general.mobileTitlebarPosition() === "bottom"
  const dragInset = () => windowDragEnabled(platform) && !mobile()

  return (
    <div
      class="relative bg-v2-background-bg-deep flex-1 min-h-0 min-w-0 flex flex-col select-none [&_input]:select-text [&_textarea]:select-text [&_[contenteditable]]:select-text"
      style={{
        // Mobile panels only need clearance for their outer border.
        "--shell-inline-inset": mobile() ? "1px" : "4px",
        // A bottom mobile titlebar leaves main's top edge to the safe area. Native Windows chrome supplies the gap;
        // retain outer-outline clearance.
        "--shell-top-inset": bottomTitlebar()
          ? "0px"
          : platform.platform === "desktop" && platform.os === "windows"
            ? "1px"
            : "4px",
        "--shell-bottom-inset": bottomTitlebar()
          ? "8px"
          : "max(0px, calc(4px - var(--safe-area-inset-bottom, env(safe-area-inset-bottom, 0px))))",
      }}
    >
      <Titlebar hidden={rail()} />
      <div class="relative flex flex-1 min-h-0 min-w-0 flex-row">
        {/* The empty inset above the panels moves the window, as the titlebar does. */}
        <Show when={dragInset()}>
          <div
            data-slot="shell-drag-inset"
            aria-hidden="true"
            class="absolute inset-x-0 top-0 h-[var(--shell-top-inset,8px)]"
            data-tauri-drag-region
          />
        </Show>
        <Show when={rail() && !fullView()}>
          <Rail project={project} />
        </Show>
        <Show when={rail() && !fullView()}>
          <div class="h-full shrink-0 bg-v2-background-bg-deep pb-[var(--shell-bottom-inset,8px)] pt-[var(--shell-top-inset,8px)]">
            <EdgePanel
              id="sessions-panel"
              label={language.t("rail.sessions.title")}
              open={sessionsPanel()}
              side="start"
              width={preferences.appearance.sessionsPanelWidth()}
              min={160}
              max={400}
              onResize={preferences.appearance.setSessionsPanelWidth}
            >
              <SessionsPanel project={project} />
            </EdgePanel>
          </div>
        </Show>
        {/* Size containment collapses percentage-height descendants in WebKit. */}
        <main
          class="flex-1 min-h-0 min-w-0 overflow-x-hidden flex flex-col items-start contain-content"
          style={{
            "padding-top": bottomTitlebar() ? "env(safe-area-inset-top, 0px)" : "0px",
            "padding-bottom":
              bottomTitlebar() || settings.active()
                ? "0px"
                : "var(--safe-area-inset-bottom, env(safe-area-inset-bottom, 0px))",
            "--settings-bottom-inset": bottomTitlebar()
              ? "40px"
              : "var(--safe-area-inset-bottom, env(safe-area-inset-bottom, 0px))",
          }}
        >
          <PluginServerCover>
            <Suspense>{props.children}</Suspense>
          </PluginServerCover>
        </main>
      </div>
      <PluginSlot at="window.bottom" input={{}} />
      <ToastRegion />
      <UploadToastHost />
    </div>
  )
}
