import { Button } from "@opencode/ui/button"
import { useDialog } from "@opencode/ui/context/dialog"
import { DockShell, DockTray } from "@opencode/ui/dock-surface"
import { Icon } from "@opencode/ui/icon"
import { Loader } from "@opencode/ui/loader"
import { useMutation } from "@tanstack/solid-query"
import { createEffect, createUniqueId, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/runtime/i18n/language"
import { useServer } from "@/runtime/server/current"
import { showToast } from "@/shell/notifications/toast"
import { useDirectoryPicker } from "@/workspaces/selection/picker"
import "./location-missing.css"

export function SessionLocationMissing(props: { sessionID: string; directory: string }) {
  const language = useLanguage()
  const server = useServer()
  const dialog = useDialog()
  const pickDirectory = useDirectoryPicker()
  const [state, setState] = createStore({ restoreFocus: false })

  let button: HTMLButtonElement | undefined

  const move = useMutation(() => ({
    mutationFn: (directory: string) => server.ctx.sdk.api.session.move({ sessionID: props.sessionID, directory }),
    onError: (error) => {
      setState("restoreFocus", true)
      showToast({
        variant: "error",
        title: language.t("session.location.moveFailed"),
        description: error instanceof Error ? error.message : language.t("common.requestFailed"),
      })
    },
  }))

  const id = createUniqueId()

  createEffect(() => {
    if (!state.restoreFocus || move.isPending || dialog.active) return
    setState("restoreFocus", false)
    button?.focus()
  })

  function choose() {
    if (move.isPending) return
    pickDirectory({
      server: server.conn,
      title: language.t("session.location.choose"),
      onSelect: (result) => {
        const selected = Array.isArray(result) ? result[0] : result

        if (selected) move.mutate(selected)

        if (!selected) setState("restoreFocus", true)
      },
    })
  }

  return (
    <div data-component="session-location-missing">
      <DockShell data-slot="location-body">
        <div
          role="group"
          aria-labelledby={`${id}-title`}
          aria-describedby={`${id}-path ${id}-description`}
          data-slot="location-status"
        >
          <Icon name="warning" />
          <div data-slot="location-details">
            <div id={`${id}-title`} role="status" data-slot="location-title">
              {language.t("session.location.unavailable")}
            </div>
            <div id={`${id}-path`} data-slot="location-path">
              {props.directory}
            </div>
            <div id={`${id}-description`} data-slot="location-description">
              {language.t("session.location.description")}
            </div>
          </div>
        </div>
      </DockShell>
      <DockTray data-slot="location-footer">
        <Button
          ref={button}
          variant={move.isPending ? "loading" : "submit"}
          size="large"
          onClick={choose}
          disabled={move.isPending}
        >
          <Show when={move.isPending}>
            <Loader />
          </Show>
          {language.t(move.isPending ? "session.location.moving" : "session.location.choose")}
        </Button>
      </DockTray>
    </div>
  )
}
