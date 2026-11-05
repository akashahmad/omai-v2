import { For, Match, Switch } from "solid-js"
import { usePlugin } from "@opencode/plugin/gui"
import { Icon } from "@opencode/ui/icon"
import type { IconName } from "@opencode/plugin/gui"
import { CheckpointsPanel } from "./checkpoints/panel"
import type { ToolId } from "./contract"
import type { CheckpointView } from "./checkpoints/view"
import { DomainsPanel } from "./domains/panel"
import type { DomainsView } from "./domains/view"
import { GitPanel } from "./git/panel"
import type { GitView } from "./git/view"
import { PublishPanel } from "./publish/panel"
import type { PublishView } from "./publish/view"
import { SeoPanel } from "./seo/panel"
import type { AuditView } from "./seo/view"

const TOOLS: ReadonlyArray<{ id: ToolId; icon: IconName; label: string }> = [
  { id: "publish", icon: "cloud-upload", label: "publish.name" },
  { id: "domains", icon: "globe", label: "domains.name" },
  { id: "seo", icon: "glasses", label: "seo.name" },
  { id: "checkpoints", icon: "outline-rotate-clockwise", label: "checkpoints.name" },
  { id: "git", icon: "branch", label: "git.name" },
]

/** The Tools section: the list of project tools beside the one on screen, as the settings pages lay out. */
export default function ToolsPanel(props: {
  /** The tool on screen; the plugin keeps it per session. */
  tool: ToolId
  onTool: (tool: ToolId) => void
  audit: AuditView
  git: GitView
  checkpoints: CheckpointView
  publish: PublishView
  domains: DomainsView
}) {
  const ctx = usePlugin()
  const tool = () => props.tool
  const setTool = (next: ToolId) => props.onTool(next)

  return (
    <div data-component="tools-panel" class="@container flex h-full min-h-0">
      <nav
        aria-label={ctx.t("list")}
        class="flex shrink-0 flex-col gap-0.5 w-44 p-2 border-e border-v2-border-border-base @max-[30rem]:w-auto"
      >
        <For each={TOOLS}>
          {(item) => (
            <button
              type="button"
              aria-current={tool() === item.id ? "page" : undefined}
              onClick={() => setTool(item.id)}
              class="flex items-center gap-2 h-8 px-2 rounded-md text-[13px] cursor-pointer transition-colors"
              classList={{
                "bg-v2-overlay-simple-overlay-hover text-v2-text-text-base font-medium": tool() === item.id,
                "text-v2-text-text-muted hover:bg-v2-overlay-simple-overlay-hover hover:text-v2-text-text-base":
                  tool() !== item.id,
              }}
            >
              <Icon name={item.icon} size="small" />
              <span class="truncate @max-[30rem]:hidden">{ctx.t(item.label)}</span>
            </button>
          )}
        </For>
      </nav>
      <div class="flex-1 min-w-0 overflow-y-auto p-4">
        <Switch>
          <Match when={tool() === "seo"}>
            <SeoPanel view={props.audit} />
          </Match>
          <Match when={tool() === "git"}>
            <GitPanel view={props.git} />
          </Match>
          <Match when={tool() === "checkpoints"}>
            <CheckpointsPanel view={props.checkpoints} />
          </Match>
          <Match when={tool() === "publish"}>
            <PublishPanel view={props.publish} onDomains={() => setTool("domains")} />
          </Match>
          <Match when={tool() === "domains"}>
            <DomainsPanel view={props.domains} onPublish={() => setTool("publish")} />
          </Match>
        </Switch>
      </div>
    </div>
  )
}
