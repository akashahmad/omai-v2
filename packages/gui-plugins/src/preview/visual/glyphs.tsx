// Small line glyphs for the inspector's fields and segmented controls, drawn in the current text colour. The shared
// icon catalog has none for typography and layout, and these are too specific to belong there.

import type { JSX } from "solid-js"

function Glyph(props: { children: JSX.Element }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      stroke-width="1.4"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      {props.children}
    </svg>
  )
}

export const AlignLeft = () => (
  <Glyph>
    <path d="M2.5 4h11M2.5 8h7M2.5 12h9" />
  </Glyph>
)

export const AlignCenter = () => (
  <Glyph>
    <path d="M2.5 4h11M4.5 8h7M3.5 12h9" />
  </Glyph>
)

export const AlignRight = () => (
  <Glyph>
    <path d="M2.5 4h11M6.5 8h7M4.5 12h9" />
  </Glyph>
)

export const AlignJustify = () => (
  <Glyph>
    <path d="M2.5 4h11M2.5 8h11M2.5 12h11" />
  </Glyph>
)

export const Row = () => (
  <Glyph>
    <path d="M2.5 8h10M10 5.5 12.5 8 10 10.5" />
  </Glyph>
)

export const Column = () => (
  <Glyph>
    <path d="M8 2.5v10M5.5 10 8 12.5l2.5-2.5" />
  </Glyph>
)

export const LineHeight = () => (
  <Glyph>
    <path d="M2.5 3h11M2.5 13h11M6 10.5 8 5.5l2 5M6.8 8.7h2.4" />
  </Glyph>
)

export const LetterSpacing = () => (
  <Glyph>
    <path d="M2.5 3v10M13.5 3v10M6 10.5 8 5.5l2 5M6.8 8.7h2.4" />
  </Glyph>
)

export const FontSize = () => (
  <Glyph>
    <path d="M2.5 12.5 6 3.5l3.5 9M3.8 9.3h4.4M10.5 12.5l1.75-4.5 1.75 4.5M11.1 11h2.3" />
  </Glyph>
)

export const Radius = () => (
  <Glyph>
    <path d="M3 13V8a5 5 0 0 1 5-5h5" />
  </Glyph>
)

export const Opacity = () => (
  <Glyph>
    <circle cx="8" cy="8" r="5.5" />
    <path d="M8 2.5v11a5.5 5.5 0 0 0 0-11Z" fill="currentColor" stroke="none" />
  </Glyph>
)

export const Gap = () => (
  <Glyph>
    <path d="M3 3v10M13 3v10M6.5 8h3" />
  </Glyph>
)

export const BorderWidth = () => (
  <Glyph>
    <path d="M2.5 4h11" stroke-width="1" />
    <path d="M2.5 8h11" stroke-width="1.8" />
    <path d="M2.5 12h11" stroke-width="2.6" />
  </Glyph>
)

export const Link = () => (
  <Glyph>
    <path d="M6.5 9.5 9.5 6.5M7 4.5l1-1a2.8 2.8 0 0 1 4 4l-1 1M9 11.5l-1 1a2.8 2.8 0 0 1-4-4l1-1" />
  </Glyph>
)

export const Palette = () => (
  <Glyph>
    <circle cx="5" cy="5" r="1.6" />
    <circle cx="11" cy="5" r="1.6" />
    <circle cx="5" cy="11" r="1.6" />
    <circle cx="11" cy="11" r="1.6" />
  </Glyph>
)

/** A one- to three-letter glyph, for fields whose name says it best (W, H). */
export const Letters = (props: { text: string }) => (
  <span class="text-[10px] font-[600] leading-none tracking-[0.02em]" aria-hidden="true">
    {props.text}
  </span>
)
