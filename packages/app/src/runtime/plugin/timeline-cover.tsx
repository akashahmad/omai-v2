import { createMemo, Show, type Accessor } from "solid-js"
import type { MountedSession, SessionScreen } from "@opencode/plugin/gui"
import { BuiltinTimelineCover } from "@opencode/plugin/gui/builtin"
import { usePluginHost } from "./host"
import { Contribution } from "./render"

/** The first plugin cover active for the session, which the screen shows over its timeline. */
export function useTimelineCover(session: Accessor<MountedSession>) {
  const host = usePluginHost()

  return createMemo(() => host.items(BuiltinTimelineCover).find((item) => item.value.active({ session: session() })))
}

/** Renders the active cover over the timeline, leaving the composer's height free at the bottom. */
export function TimelineCover(props: {
  cover: ReturnType<ReturnType<typeof useTimelineCover>>
  screen: SessionScreen
  session: MountedSession
  inset: number
}) {
  return (
    <Show when={props.cover} keyed>
      {(item) => (
        <div
          data-slot="session-timeline-cover"
          class="absolute inset-0 z-[60] flex flex-col bg-v2-background-bg-base"
          style={{ "padding-bottom": `${props.inset}px` }}
        >
          <Contribution plugin={item.plugin}>
            {() =>
              item.value.render({
                screen: props.screen,
                get session() {
                  return props.session
                },
              })
            }
          </Contribution>
        </div>
      )}
    </Show>
  )
}
