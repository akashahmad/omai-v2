import { Show, type ParentProps } from "solid-js"
import "./session-frame.css"

export function SessionRouteFrame(props: ParentProps<{ padded?: boolean }>) {
  return (
    <div
      class="relative flex size-full flex-col"
      classList={{
        "px-[var(--shell-inline-inset,8px)] pb-[var(--shell-bottom-inset,8px)] pt-[var(--shell-top-inset,8px)]":
          props.padded,
      }}
    >
      {props.children}
    </div>
  )
}

export function SessionPanelFrame(props: ParentProps<{ raised?: boolean; working?: boolean }>) {
  return (
    <div
      class="relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-[6px] bg-v2-background-bg-base"
      classList={{
        "shadow-[var(--v2-elevation-raised)]": props.raised,
      }}
    >
      <Show when={props.working}>
        <div data-slot="session-working-bar" aria-hidden="true" />
      </Show>
      {props.children}
    </div>
  )
}
