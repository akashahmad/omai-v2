import { getOwner, lazy, Suspense } from "solid-js"
import { Icon } from "@opencode/ui/icon"
import type { Plugin } from "@opencode/plugin/gui"
import { BuiltinPanel, onIdle, type BuiltinPanelTab } from "@opencode/plugin/gui/builtin"
import type ToolsDefinition from "./index"
import { checkpointViews } from "./checkpoints/view"
import { domainsViews } from "./domains/view"
import { gitViews } from "./git/view"
import { publishViews } from "./publish/view"
import { auditViews } from "./seo/view"

/**
 * The right panel's Tools section: project tools such as the website audit, Git, Checkpoints, Publishing and Domains. They run
 * on the server, so their views live per session and outlive the panel.
 */
const setup: Plugin.Setup<typeof ToolsDefinition> = (ctx) => {
  const layout = ctx.layout
  const sessions = ctx.sessions
  const audit = auditViews(getOwner())

  // The sessions whose shell tab is still open; the Git, Checkpoints, Publishing and Domains views of the others are
  // dropped.
  const open = () =>
    [...sessions.list().map((session) => session.key), sessions.current()?.key].filter((key) => key !== undefined)

  const git = gitViews(getOwner(), open)
  const checkpoints = checkpointViews(getOwner(), open)
  const publish = publishViews(getOwner(), open)
  const domains = domainsViews(getOwner(), open)

  const ToolsPanel = lazy(() => import("./panel"))

  onIdle(() => void ToolsPanel.preload())

  // One tab object for every session, so a session switch never renders its trigger again.
  const tab: BuiltinPanelTab = {
    id: "tools",
    get title() {
      return ctx.t("tab.title")
    },
    label: () => (
      <div class="flex items-center gap-1.5">
        <Icon name="wrench" size="small" />
        <span>{ctx.t("tab.title")}</span>
      </div>
    ),
    pinned: true,
    draggable: false,
    closable: false,
    section: "tools",
    dom: { tab: "session-side-panel-tools-tab", panel: "session-side-panel-tools-tabpanel" },
  }

  ctx.add(BuiltinPanel, {
    id: "tools",
    region: "side",
    list: (input) => (!layout.narrow() && input.session.project ? [tab] : []),
    render: (props) => (
      <Suspense>
        <ToolsPanel
          audit={audit(
            () => props.session,
            ctx.t,
            () => ctx.locale.locale(),
          )}
          git={git(() => props.session, ctx.t)}
          checkpoints={checkpoints(() => props.session, {
            t: ctx.t,
            plural: ctx.plural,
            get locale() {
              return ctx.locale.locale()
            },
          })}
          publish={publish(() => props.session, ctx.t)}
          domains={domains(() => props.session)}
        />
      </Suspense>
    ),
  })
}

export default setup
