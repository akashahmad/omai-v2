// Until the user drags the divider, the chat panel takes 35% of the pane row and the side panel (the preview first)
// the other 65%, on every screen size. A drag keeps its width, leaving the side pane at least its hard minimum. The
// chat minimum leaves the session header room for its title beside its controls, macOS traffic lights included.
export const SESSION_PANEL_WIDTH_MIN = 400

const SIDE_PANE_WIDTH_MIN = 320

/** The chat panel's share of the pane row until the user drags the divider. */
export const DEFAULT_SHARE = 0.35

// The row's 4px gap between the panels.
const GAP = 4

export function sessionPanelWidthMax(input: { available: number; split: boolean; resized: boolean }) {
  if (input.resized) return Math.max(SESSION_PANEL_WIDTH_MIN, input.available - SIDE_PANE_WIDTH_MIN)

  return Math.max(SESSION_PANEL_WIDTH_MIN, Math.round(input.available * DEFAULT_SHARE))
}

// The same limit in CSS, against the pane row's width less its gap, so the chat panel follows the row on the frame
// it resizes, e.g. while the left sidebar moves, rather than after a ResizeObserver callback.
export function sessionPanelWidthCss(input: { width: number; split: boolean; resized: boolean }) {
  if (!input.resized) return `max(${SESSION_PANEL_WIDTH_MIN}px, calc((100% - ${GAP}px) * ${DEFAULT_SHARE}))`

  // The outer floor raises a width stored below the minimum, e.g. dragged before it rose.
  return `max(${SESSION_PANEL_WIDTH_MIN}px, min(${input.width}px, 100% - ${SIDE_PANE_WIDTH_MIN + GAP}px))`
}

// `available` is undefined until the layout row is first measured; render the
// stored width untouched until then to avoid a first-frame snap.
export function clampSessionPanelWidth(input: {
  width: number
  available: number | undefined
  split: boolean
  resized: boolean
}) {
  if (input.available === undefined) return Math.max(SESSION_PANEL_WIDTH_MIN, input.width)

  if (!input.resized) return sessionPanelWidthMax({ ...input, available: input.available })
  const width = Math.max(SESSION_PANEL_WIDTH_MIN, input.width)

  return Math.min(width, sessionPanelWidthMax({ ...input, available: input.available }))
}
