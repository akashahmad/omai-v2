import { expect, test } from "bun:test"
import { clampSessionPanelWidth, sessionPanelWidthCss } from "./session-panel-width"

test.each([
  // By default the chat takes 30% of the row and the side panel (the preview) the other 70%, on every screen size.
  ["gives the chat 30% of the row by default", 600, 1700, false, false, 510],
  ["keeps 30% on a wide screen", 600, 3440, false, false, 1032],
  ["keeps 30% whatever width was stored before", 1600, 2000, true, false, 600],
  ["holds the chat panel minimum when 30% is too narrow", 600, 700, false, false, 400],
  ["never drops below the chat panel minimum on small windows", 1600, 0, false, false, 400],
  ["skips clamping before the layout is measured", 1600, undefined, false, false, 1600],
  ["lets a dragged width leave the side pane its hard minimum, split diffs included", 1600, 1700, true, true, 1380],
  ["keeps a dragged width below the default", 420, 900, true, true, 420],
  ["never drops a dragged width below the hard chat minimum", 1600, 0, false, true, 400],
  ["raises a width dragged below the hard chat minimum before it rose", 320, 1700, false, true, 400],
])("%s", (_name, width, available, split, resized, expected) => {
  expect(clampSessionPanelWidth({ width, available, split, resized })).toBe(expected)
})

test("the default width in CSS is 30% of the row", () => {
  expect(sessionPanelWidthCss({ width: 600, split: false, resized: false })).toBe(
    "max(400px, calc((100% - 4px) * 0.3))",
  )
})
