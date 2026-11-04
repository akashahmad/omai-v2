import { Show, type JSX } from "solid-js"
import { ResizeHandle } from "@opencode/ui/resize-handle"
import { createPanelMotion, panelOpacity, setPanelResizing } from "@/shell/panel-motion"

/**
 * A resizable card beside the session that opens and closes on the side panel's spring. `side` is the edge of the
 * neighbouring content it sits on; the card slides out from under that content's edge, and its handle sits on that
 * edge. `gap` is the space between the card and the content, which closes with the card.
 */
export function EdgePanel(props: {
  open: boolean
  side: "start" | "end"
  width: number
  min: number
  max: number
  gap?: number
  onResize: (width: number) => void
  id: string
  label: string
  class?: string
  children: JSX.Element
}) {
  let outer: HTMLDivElement | undefined
  let card: HTMLElement | undefined

  const motion = createPanelMotion({
    open: () => props.open,
    // Reads the width before touching the box, so a resize repaints even when the first paint ran before it mounted.
    paint: (closed) => {
      const span = props.width + (props.gap ?? 0)

      if (outer) outer.style.width = `${span * (1 - closed)}px`

      if (!card) return
      card.style.opacity = panelOpacity(closed)
      // Clips the card, not a box around it, so its shadow shows on every edge. Only the part that has slid past the
      // panel's box, on the side away from the content, is cut.
      const far = (props.side === "start") === !card.matches(":dir(rtl)") ? "left" : "right"
      const cut = closed === 0 ? "-8px" : `${span * closed}px`
      card.style.clipPath = far === "left" ? `inset(-8px -8px -8px ${cut})` : `inset(-8px ${cut} -8px -8px)`
    },
    element: () => card,
    distance: () => props.width,
  })

  return (
    <Show when={motion.present()}>
      <div ref={outer} data-component="edge-panel" class="relative h-full shrink-0">
        <div class="relative size-full">
          <aside
            ref={card}
            id={props.id}
            aria-label={props.label}
            inert={!props.open || undefined}
            class={`absolute inset-y-0 overflow-hidden rounded-[6px] bg-v2-background-bg-base shadow-[var(--v2-elevation-raised)] ${props.side === "start" ? "end-0" : "start-0"} ${props.class ?? ""}`}
            style={{
              width: `${props.width}px`,
              [props.side === "start" ? "margin-inline-end" : "margin-inline-start"]: `${props.gap ?? 0}px`,
            }}
          >
            {props.children}
          </aside>
        </div>
        <Show when={props.open}>
          <ResizeHandle
            direction="horizontal"
            edge={props.side === "start" ? "end" : "start"}
            style={{ [props.side === "start" ? "inset-inline-end" : "inset-inline-start"]: `${props.gap ?? 0}px` }}
            size={props.width}
            min={props.min}
            max={props.max}
            onResize={props.onResize}
            onDraggingChange={setPanelResizing}
          />
        </Show>
      </div>
    </Show>
  )
}
