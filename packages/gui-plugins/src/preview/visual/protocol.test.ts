import { describe, expect, test } from "bun:test"
import { command, visualMessage } from "./protocol"

const ORIGIN = "http://127.0.0.1:61082"

// Two real windows: the preview frame, and some other window that must not be trusted.
const frame = window.open() ?? window

const other = window

const element = {
  path: "body > main > p:nth-of-type(1)",
  fingerprint: { tag: "p", classes: ["lead"], text: "One", attrs: {}, index: 2 },
  label: "Text",
  tag: "p",
  text: "One",
  rect: { x: 0, y: 0, width: 100, height: 20 },
  styles: { color: "rgb(0, 0, 0)" },
  isText: true,
  plainText: true,
  isImage: false,
  layout: "block",
  breadcrumb: [{ label: "Text", path: "body > main > p:nth-of-type(1)" }],
}

describe("visualMessage", () => {
  test("accepts a select message from the frame", () => {
    const message = visualMessage(
      { origin: ORIGIN, source: frame, data: { type: "omai:visual:select", v: 1, element } },
      ORIGIN,
      frame,
    )

    expect(message).toMatchObject({ type: "omai:visual:select", element: { tag: "p", label: "Text" } })
  })

  test("accepts a cleared selection and a change", () => {
    expect(visualMessage({ origin: ORIGIN, source: frame, data: { type: "omai:visual:select", v: 1, element: null } }, ORIGIN, frame))
      .toEqual({ type: "omai:visual:select", v: 1, element: null })
    const change = { path: "p", fingerprint: element.fingerprint, kind: "style", property: "color", before: "red", after: "blue" }

    expect(visualMessage({ origin: ORIGIN, source: frame, data: { type: "omai:visual:change", v: 1, change } }, ORIGIN, frame))
      .toMatchObject({ change: { kind: "style", after: "blue" } })
  })

  test("accepts optional fields sent as undefined, as structured clone keeps them", () => {
    const sent = { ...element, text: undefined, src: undefined, alt: undefined, href: undefined, source: undefined, fingerprint: { ...element.fingerprint, id: undefined } }

    expect(visualMessage({ origin: ORIGIN, source: frame, data: { type: "omai:visual:select", v: 1, element: sent } }, ORIGIN, frame))
      .toMatchObject({ element: { tag: "p" } })
  })

  test("rejects messages from another origin or another window", () => {
    const data = { type: "omai:visual:select", v: 1, element: null }

    expect(visualMessage({ origin: "https://evil.example", source: frame, data }, ORIGIN, frame)).toBeUndefined()
    expect(visualMessage({ origin: ORIGIN, source: other, data }, ORIGIN, frame)).toBeUndefined()
  })

  test("rejects an unknown version or a malformed element", () => {
    expect(visualMessage({ origin: ORIGIN, source: frame, data: { type: "omai:visual:select", v: 2, element: null } }, ORIGIN, frame))
      .toBeUndefined()
    const { rect: _, ...broken } = element

    expect(visualMessage({ origin: ORIGIN, source: frame, data: { type: "omai:visual:select", v: 1, element: broken } }, ORIGIN, frame))
      .toBeUndefined()
  })

  test("caps oversized fingerprint text", () => {
    const long = { ...element, fingerprint: { ...element.fingerprint, text: "x".repeat(121) } }

    expect(visualMessage({ origin: ORIGIN, source: frame, data: { type: "omai:visual:select", v: 1, element: long } }, ORIGIN, frame))
      .toBeUndefined()
  })
})

test("command wraps one command for the page", () => {
  expect(command({ name: "style", property: "color", value: "red" })).toEqual({
    type: "omai:visual:command",
    v: 1,
    command: { name: "style", property: "color", value: "red" },
  })
})
