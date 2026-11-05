import { getOwner, lazy, Suspense } from "solid-js"
import { Icon } from "@opencode/ui/icon"
import type { Plugin } from "@opencode/plugin/gui"
import { BuiltinPanel, onIdle, type BuiltinPanelTab } from "@opencode/plugin/gui/builtin"
import type ToolsDefinition from "./index"
import { auditViews } from "./seo/view"

/**
 * The right panel's Tools section: project tools such as the website audit. The audit runs on the server, so its view
 * lives per session and outlives the panel.
 */
const setup: Plugin.Setup<typeof ToolsDefinition> = (ctx) => {
  const layout = ctx.layout
  const audit = auditViews(getOwner())
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
        <ToolsPanel audit={audit(() => props.session, ctx.t, () => ctx.locale.locale())} />
      </Suspense>
    ),
  })
}

export default setup
