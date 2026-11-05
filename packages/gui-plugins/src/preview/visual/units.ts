// CSS lengths as the inspector's number fields read and step them: "12" means 12px, units stay put.

export type Length = { value: number; unit: string }

const LENGTH = /^(-?\d*\.?\d+)\s*(px|rem|em|%|vh|vw|pt|ch)?$/

/** A typed or computed length, in px when no unit is given; undefined for `auto` and anything not a length. */
export function parseLength(input: string): Length | undefined {
  const match = LENGTH.exec(input.trim())

  if (!match) return undefined

  return { value: Number(match[1]), unit: match[2] ?? "px" }
}

export const formatLength = (length: Length) => `${Number(length.value.toFixed(3))}${length.unit}`

/** The length moved by `delta` in its own unit; anything that isn't a length is returned unchanged. */
export function step(input: string, delta: number) {
  const length = parseLength(input)

  return length ? formatLength({ ...length, value: length.value + delta }) : input
}

const RGB = /^rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/i

/** A colour as `#rrggbb` for the native colour picker; undefined when it isn't a plain rgb or hex colour. */
export function toHex(input: string) {
  const value = input.trim().toLowerCase()

  if (/^#[0-9a-f]{6}$/.test(value)) return value

  if (/^#[0-9a-f]{3}$/.test(value)) return `#${[...value.slice(1)].map((char) => char + char).join("")}`
  const match = RGB.exec(value)

  if (!match) return undefined

  return `#${match.slice(1, 4).map((part) => Math.min(255, Number(part)).toString(16).padStart(2, "0")).join("")}`
}

// The fourth comma-separated channel, or what follows the slash in the space-separated form.
const ALPHA = /^rgba?\((?:[^,/]+,){3}\s*([\d.]+)(%?)\s*\)$|^rgba?\([^/]+\/\s*([\d.]+)(%?)\s*\)$/i

/** A colour's opacity from 0 to 1: `transparent` is 0, colours without an alpha are 1. */
export function alphaOf(input: string) {
  const value = input.trim().toLowerCase()

  if (value === "transparent") return 0
  const match = ALPHA.exec(value)

  if (!match) return 1

  return Math.min(1, Number(match[1] ?? match[3]) / ((match[2] ?? match[4]) ? 100 : 1))
}

/** A `#rrggbb` colour at the given opacity: the hex itself when opaque, `rgb(r g b / a)` otherwise. */
export function withAlpha(hex: string, alpha: number) {
  if (alpha >= 1) return hex
  const channels = [1, 3, 5].map((start) => Number.parseInt(hex.slice(start, start + 2), 16))

  return `rgb(${channels.join(" ")} / ${Number(Math.max(0, alpha).toFixed(2))})`
}

/**
 * Whether two single box shadows are the same, however they are written: the browser reports a computed shadow with
 * the colour first and every length in px (`rgba(0, 0, 0, 0.08) 0px 1px 2px 0px`), unlike the way it was set.
 */
export function sameShadow(a: string, b: string) {
  return shadowKey(a) === shadowKey(b)
}

function shadowKey(input: string) {
  const value = input.trim().toLowerCase()

  if (value === "none" || value === "") return "none"
  const color = /rgba?\([^)]*\)|#[0-9a-f]{3,8}\b/.exec(value)?.[0] ?? "rgb(0 0 0)"
  const lengths = value.replace(color, " ").trim().split(/\s+/).map((part) => parseLength(part)?.value ?? Number.NaN)
  // A spread of 0 is the default, so "0 1px 2px" and "0px 1px 2px 0px" are the same shadow.
  const trimmed = lengths.length === 4 && lengths[3] === 0 ? lengths.slice(0, 3) : lengths

  return `${trimmed.join(",")}|${toHex(color) ?? color}|${alphaOf(color)}`
}
