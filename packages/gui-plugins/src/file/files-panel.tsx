import { onCleanup } from "solid-js"
import type { ChangeKind } from "@opencode/plugin/gui/review"
import { createKeyed, usePlugin, type MountedSession, type SessionScreen } from "@opencode/plugin/gui"
import { current, useShared } from "./context"
import PierreFileTree from "./pierre-tree"

/** The narrow "All files" column: the workspace tree on its own, opening files in the side region. */
export default function FilesPanel(props: { session: MountedSession; screen: SessionScreen }) {
  const ctx = usePlugin()
  const shared = useShared()
  const empty = new Map<string, ChangeKind>()
  const changes = () => current(shared.changes())

  // Change markers in the tree load while the column shows.
  createKeyed(changes, (service) => onCleanup(service.watch(props.screen, "files")))

  return (
    <div data-component="session-files-panel" class="flex h-full min-h-0 flex-col">
      <div class="flex h-12 shrink-0 items-center justify-center px-3 text-14-medium text-v2-text-text-base">
        {ctx.t("tree.all")}
      </div>
      <div class="min-h-0 flex-1">
        <PierreFileTree
          session={props.session}
          screen={props.screen}
          kinds={changes()?.kinds(props.session) ?? empty}
          draggable
          onFileClick={(node) => shared.open(props.session, node.path, { tab: "preview" })}
          onFileDoubleClick={(node) => shared.open(props.session, node.path)}
        />
      </div>
    </div>
  )
}
