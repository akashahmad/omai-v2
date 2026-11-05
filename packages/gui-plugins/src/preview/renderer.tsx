import { getOwner, lazy, Show, Suspense } from "solid-js"
import { Icon } from "@opencode/ui/icon"
import { Command, usePanel, type Plugin } from "@opencode/plugin/gui"
import { BuiltinPanel, BuiltinSlot, BuiltinTimelineCover, onIdle, type BuiltinPanelTab } from "@opencode/plugin/gui/builtin"
import type PreviewDefinition from "./index"
import { uuid } from "@opencode/util/uuid"
import { previewViews } from "./view"
import { askNote } from "./visual/ask"
import { ImageDialog } from "./visual/image-dialog"

const TAB = "preview"

/**
 * The right panel's Preview section: the project's running app, and its controls in the panel's toolbar. Both read
 * one view per session, so the device, zoom and page on screen agree.
 */
const setup: Plugin.Setup<typeof PreviewDefinition> = (ctx) => {
  const layout = ctx.layout

  const view = previewViews(getOwner(), {
    // "Ask AI" attaches the element to the composer, so a bigger change can be described in words.
    ask: (_session, element) => {
      const composer = ctx.screen.current()?.composer

      if (!composer) return
      composer.attach(askNote(element, { origin: ctx.id, commentID: uuid(), subtitle: ctx.t("visual.ask.subtitle") }))
      composer.focus()
    },
    image: (preview, element) =>
      void ctx.dialogs.open((dialog) => <ImageDialog view={preview} element={element} close={dialog.close} />),
    labels: () => ({
      parent: ctx.t("visual.tool.parent"),
      edit: ctx.t("visual.tool.edit"),
      image: ctx.t("visual.tool.image"),
      ask: ctx.t("visual.tool.ask"),
      deselect: ctx.t("visual.tool.deselect"),
    }),
  })

  const Inspector = lazy(() => import("./visual/inspector"))

  const PreviewPanel = lazy(() => import("./panel"))
  const PreviewToolbar = lazy(() => import("./toolbar").then((module) => ({ default: module.PreviewToolbar })))

  onIdle(() => {
    void Inspector.preload()
    void PreviewPanel.preload()
    void PreviewToolbar.preload()
  })

  // One tab object for every session, so a session switch never renders its trigger again.
  const tab: BuiltinPanelTab = {
    id: TAB,
    get title() {
      return ctx.t("tab.title")
    },
    label: () => (
      <div class="flex items-center gap-1.5">
        <Icon name="globe" size="small" />
        <span>{ctx.t("tab.title")}</span>
      </div>
    ),
    pinned: true,
    // The right panel opens on the preview when nothing else is selected.
    fallback: true,
    draggable: false,
    closable: false,
    section: "preview",
    dom: { tab: "session-side-panel-preview-tab", panel: "session-side-panel-preview-tabpanel" },
  }

  ctx.add(BuiltinPanel, {
    id: "preview",
    region: "side",
    list: (input) => (!layout.narrow() && input.session.project ? [tab] : []),
    render: (props) => {
      const frame = usePanel()

      return (
        <Suspense>
          <PreviewPanel view={view(() => props.session)} visible={frame.visible} />
        </Suspense>
      )
    },
  })

  ctx.add(BuiltinSlot, {
    at: "session.side.toolbar",
    render: (input) => (
      <Show when={input.section === "preview" && input.session.project}>
        <Suspense>
          <PreviewToolbar view={view(() => input.session)} />
        </Suspense>
      </Show>
    ),
  })

  // While visual editing is on, the inspector covers the chat timeline; the composer stays usable for "Ask AI".
  ctx.add(BuiltinTimelineCover, {
    id: "visual",
    active: (input) => !layout.narrow() && view(() => input.session).visual.enabled(),
    render: (input) => (
      <Suspense>
        <Inspector view={view(() => input.session)} />
      </Suspense>
    ),
  })

  ctx.add(
    Command,
    (): Command => {
      const session = ctx.sessions.current()
      const preview = session ? view(() => session) : undefined

      return {
        id: "visual",
        title: ctx.t("visual.command"),
        bind: "mod+shift+e",
        enabled: !!preview?.running(),
        run: () => preview?.visual.toggle(),
      }
    },
  )
}

export default setup
