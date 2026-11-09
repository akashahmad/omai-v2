import { type ParentProps } from "solid-js"
import { ModelsProvider, type VisibilitySource } from "@/providers/models/models"
import { ServerProvider } from "@/runtime/server/current"
import { ServerConnection } from "@/runtime/server/registry"

export function SettingsServerDataScope(
  props: ParentProps<{ server: ServerConnection.Any; directory?: string; visibility?: VisibilitySource }>,
) {
  return (
    <ServerProvider conn={props.server}>
      <ModelsProvider directory={props.directory} visibility={props.visibility}>
        {props.children}
      </ModelsProvider>
    </ServerProvider>
  )
}
