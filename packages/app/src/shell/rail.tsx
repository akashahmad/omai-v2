import { restrictions } from "@/controlplane/restrictions"
import { Show, type JSX } from "solid-js"
import { useLocation, useNavigate } from "@solidjs/router"
import { Mark } from "@opencode/ui/logo"
import { BrandIcon } from "@/shell/brand-icon"
import { Keybind } from "@opencode/ui/keybind"
import { Tooltip } from "@opencode/ui/tooltip"
import { useCommand } from "@/shell/commands/command"
import { useLanguage } from "@/runtime/i18n/language"
import { useLayout } from "@/shell/state/layout"
import { useSettings } from "@/settings/model"
import { useSettingsDialog } from "@/settings/command"
import type { OpenProject } from "@/shell/sessions-panel"
import { sidebarToggleCommand } from "@/shell/shell"
import { Menu } from "@opencode/ui/menu"
import { useControlPlaneOptional } from "@/controlplane/session"

const BUTTON =
  "flex size-9 shrink-0 items-center justify-center rounded-[8px] text-v2-icon-icon-muted transition-colors hover:bg-v2-overlay-simple-overlay-hover hover:text-v2-icon-icon-base focus-visible:bg-v2-overlay-simple-overlay-hover focus-visible:text-v2-icon-icon-base focus-visible:outline-none disabled:pointer-events-none disabled:opacity-40 aria-pressed:bg-v2-overlay-simple-overlay-hover aria-pressed:text-v2-icon-icon-base aria-[current=page]:bg-v2-overlay-simple-overlay-hover aria-[current=page]:text-v2-icon-icon-base"

const ACCOUNT =
  "mt-1 flex size-9 shrink-0 cursor-default items-center justify-center rounded-full border border-v2-border-border-muted text-v2-icon-icon-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-v2-border-border-base"

function AccountGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <circle cx="10" cy="7" r="3.25" stroke="currentColor" stroke-width="1.25" />
      <path d="M3.75 16.5c.9-3 3.3-4.5 6.25-4.5s5.35 1.5 6.25 4.5" stroke="currentColor" stroke-width="1.25" />
    </svg>
  )
}

/** The always-visible strip down the window's start edge: navigation, the session's panels and the account. */
export function Rail(props: { project: OpenProject }) {
  const language = useLanguage()
  const command = useCommand()
  const navigate = useNavigate()
  const location = useLocation()
  const layout = useLayout()
  const settings = useSettings()
  const openSettings = useSettingsDialog()
  const project = props.project
  // Multi-user mode: the account slot holds the signed-in user and log out.
  const controlPlane = useControlPlaneOptional()

  // Terminal, file tree and the side panel belong to an open session.
  const inSession = () => layout.route().type === "session"
  const page = (path: string) => (location.pathname === path ? "page" : undefined)

  return (
    <nav
      data-component="rail"
      aria-label={language.t("rail.label")}
      class="flex h-full w-12 shrink-0 flex-col items-center gap-1 bg-v2-background-bg-deep pb-[var(--shell-bottom-inset,8px)] pt-[var(--shell-top-inset,8px)]"
    >
      <RailItem label={language.t("rail.home")}>
        <button
          type="button"
          data-action="rail-home"
          aria-label={language.t("rail.home")}
          class={BUTTON}
          onClick={() => navigate("/")}
        >
          <BrandIcon class="size-8 rounded-[7px]" />
        </button>
      </RailItem>
      <div class="h-2 shrink-0" aria-hidden="true" />
      <RailItem label={language.t("command.session.new")}>
        <button
          type="button"
          data-action="rail-new-session"
          aria-label={language.t("command.session.new")}
          class={BUTTON}
          disabled={!project.current() || project.creating()}
          onClick={() => void project.create()}
        >
          <Glyph>
            <path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
            <path d="M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852z" />
          </Glyph>
        </button>
      </RailItem>

      <div class="h-4 shrink-0" aria-hidden="true" />

      {/* An upcoming feature holds its place; it does nothing yet. */}
      <RailItem label={language.t("rail.comingSoon")}>
        <button
          type="button"
          data-action="rail-upcoming"
          aria-label={language.t("rail.comingSoon")}
          aria-disabled="true"
          class={`${BUTTON} cursor-default`}
        >
          <Mark class="size-5" />
        </button>
      </RailItem>
      <RailItem label={language.t("projects.title")}>
        <button
          type="button"
          data-action="rail-projects"
          aria-label={language.t("projects.title")}
          aria-current={page("/")}
          class={BUTTON}
          onClick={() => navigate("/")}
        >
          <Glyph>
            <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
          </Glyph>
        </button>
      </RailItem>
      {/* Hidden with the panel an admin hid from this user. */}
      <Show when={!restrictions.hidden("terminal")}>
        <RailItem label={language.t("rail.terminal")} command="terminal.toggle">
          <button
            type="button"
            data-action="rail-terminal"
            aria-label={language.t("rail.terminal")}
            class={BUTTON}
            disabled={!inSession()}
            onClick={() => command.trigger("terminal.toggle")}
          >
            <Glyph>
              <rect width="18" height="18" x="3" y="3" rx="2" />
              <path d="m7 11 2-2-2-2" />
              <path d="M11 13h4" />
            </Glyph>
          </button>
        </RailItem>
      </Show>
      <RailItem label={language.t("rail.panel")} command="review.toggle">
        <button
          type="button"
          data-action="rail-panel"
          aria-label={language.t("rail.panel")}
          aria-controls="review-panel"
          class={BUTTON}
          disabled={!inSession()}
          onClick={() => command.trigger("review.toggle")}
        >
          <PanelGlyph />
        </button>
      </RailItem>
      <Show when={!restrictions.hidden("file")}>
        <RailItem label={language.t("rail.files")}>
          <button
            type="button"
            data-action="rail-files"
            aria-label={language.t("rail.files")}
            class={BUTTON}
            aria-controls="session-files-panel"
            aria-pressed={inSession() && settings.appearance.fileTreeOpen()}
            disabled={!inSession()}
            onClick={() => settings.appearance.setFileTreeOpen(!settings.appearance.fileTreeOpen())}
          >
            <Glyph>
              <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
              <path d="M2 10h20" />
            </Glyph>
          </button>
        </RailItem>
      </Show>
      <RailItem label={language.t("rail.previous")}>
        <button
          type="button"
          data-action="rail-back"
          aria-label={language.t("rail.previous")}
          class={BUTTON}
          disabled={!project.neighbour(1)}
          onClick={() => project.step(1)}
        >
          <Glyph>
            <path d="m15 18-6-6 6-6" />
          </Glyph>
        </button>
      </RailItem>
      <RailItem label={language.t("rail.next")}>
        <button
          type="button"
          data-action="rail-forward"
          aria-label={language.t("rail.next")}
          class={BUTTON}
          disabled={!project.neighbour(-1)}
          onClick={() => project.step(-1)}
        >
          <Glyph>
            <path d="m9 18 6-6-6-6" />
          </Glyph>
        </button>
      </RailItem>

      <div class="flex-1" />

      <RailItem label={language.t("sidebar.settings")} command="settings.open">
        <button
          type="button"
          data-action="rail-settings"
          aria-label={language.t("sidebar.settings")}
          aria-current={layout.route().type === "settings" ? "page" : undefined}
          class={BUTTON}
          onClick={() => openSettings()}
        >
          <Glyph>
            <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
            <circle cx="12" cy="12" r="3" />
          </Glyph>
        </button>
      </RailItem>
      <RailItem label={language.t("rail.sessionsPanel")} command={sidebarToggleCommand.id}>
        <button
          type="button"
          data-action="rail-sessions-panel"
          aria-label={language.t("rail.sessionsPanel")}
          aria-controls="sessions-panel"
          aria-pressed={inSession() && settings.appearance.sidebarOpen()}
          class={BUTTON}
          disabled={!inSession()}
          onClick={() => command.trigger(sidebarToggleCommand.id)}
        >
          <PanelGlyph />
        </button>
      </RailItem>
      <Show
        when={controlPlane}
        fallback={
          // There is no sign-in yet; the account slot holds its place.
          <RailItem label={language.t("rail.account")}>
            <button
              type="button"
              data-action="rail-account"
              aria-label={language.t("rail.account")}
              aria-disabled="true"
              class={ACCOUNT}
            >
              <AccountGlyph />
            </button>
          </RailItem>
        }
      >
        {(session) => (
          <Menu gutter={6} modal={false} placement="right-end">
            <Menu.Trigger
              as="button"
              type="button"
              data-action="rail-account"
              aria-label={language.t("rail.account")}
              class={`${ACCOUNT} cursor-pointer hover:text-v2-icon-icon-base`}
            >
              <AccountGlyph />
            </Menu.Trigger>
            <Menu.Portal>
              <Menu.Content>
                <div class="px-2 py-1.5 text-12-regular text-v2-text-text-muted">{session().state.user?.username}</div>
                <Menu.Separator />
                <Menu.Item data-action="rail-logout" onSelect={() => void session().logout()}>
                  {language.t("auth.logout")}
                </Menu.Item>
              </Menu.Content>
            </Menu.Portal>
          </Menu>
        )}
      </Show>
    </nav>
  )
}

function RailItem(props: { label: string; command?: string; children: JSX.Element }) {
  const command = useCommand()
  const keys = () => (props.command ? command.keybindParts(props.command) : [])

  return (
    <Tooltip
      placement="right"
      openDelay={400}
      value={
        <span class="flex items-center gap-2">
          {props.label}
          <Show when={keys().length > 0}>
            <Keybind keys={keys()} variant="neutral" />
          </Show>
        </span>
      }
    >
      {props.children}
    </Tooltip>
  )
}

/** The screenshots' line icons: 24-unit artwork drawn at 20px with a light stroke. */
function Glyph(props: { children: JSX.Element }) {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      {props.children}
    </svg>
  )
}

function PanelGlyph() {
  return (
    <Glyph>
      <rect width="18" height="18" x="3" y="3" rx="2" />
      <path d="M9 3v18" />
    </Glyph>
  )
}
