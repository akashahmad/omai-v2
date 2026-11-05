// The inspector's inputs. Each one shows the element's current value and commits a new CSS value through `onCommit`;
// the editor in the page applies it live and reports it back as a pending change. A field whose property has a
// pending change shows its label in the accent colour.

import { createSignal, For, Show, type JSX } from "solid-js"
import { Icon } from "@opencode/ui/icon"
import { Link, Palette } from "./glyphs"
import { alphaOf, parseLength, step, toHex, withAlpha } from "./units"

/** The filled, borderless shell every field shares; it lights up on hover and takes a focus ring. */
export const shell =
  "group/field relative flex items-center w-full min-w-0 rounded-lg bg-v2-overlay-simple-overlay-hover transition-[background-color,box-shadow] duration-150 hover:shadow-[inset_0_0_0_1px_var(--v2-border-border-base)] focus-within:bg-v2-background-bg-base focus-within:shadow-[inset_0_0_0_1px_#1a64d6,0_0_0_3px_rgb(26_100_214/0.14)]"

const bare = "h-8 min-w-0 bg-transparent text-12-regular text-v2-text-text-base outline-none tabular-nums placeholder:text-v2-text-text-faint"

const CHECKER = "repeating-conic-gradient(rgb(0 0 0 / 0.12) 0 25%, transparent 0 50%) 0 0 / 8px 8px"

const PLAIN_NUMBER = /^-?\d*\.?\d+$/

/** A field's label; accented with a dot while the property has a pending change. */
export function Caption(props: { label: string; changed?: boolean; onPointerDown?: (event: PointerEvent) => void; scrub?: boolean }) {
  return (
    <span
      class="flex items-center gap-1 min-w-0 text-[11px] leading-4 select-none"
      classList={{
        "text-[color-mix(in_srgb,#1a64d6_85%,var(--v2-text-text-base))]": props.changed,
        "text-v2-text-text-muted": !props.changed,
        "cursor-ew-resize": props.scrub,
      }}
      onPointerDown={(event) => props.onPointerDown?.(event)}
    >
      <span class="truncate">{props.label}</span>
      <Show when={props.changed}>
        <span class="size-1 shrink-0 rounded-full bg-[#1a64d6]" />
      </Show>
    </span>
  )
}

/** A label above a control. */
export function Field(props: { label: string; children: JSX.Element; wide?: boolean; changed?: boolean }) {
  return (
    <label class="flex flex-col gap-1.5 min-w-0" classList={{ "col-span-2": props.wide }}>
      <Caption label={props.label} changed={props.changed} />
      {props.children}
    </label>
  )
}

/**
 * A length or number, shown as its number with the unit beside it. Typing then Enter or leaving the field commits
 * (a bare number keeps the current unit); ↑/↓ and the stepper move by 1 (Shift by 10); dragging the label or the glyph
 * left or right scrubs.
 */
export function NumberField(props: {
  label: string
  value: string
  onCommit: (value: string) => void
  /** Bare numbers stay bare (line height, opacity) instead of taking the current unit. */
  unitless?: boolean
  glyph?: JSX.Element
  changed?: boolean
  wide?: boolean
}) {
  const [draft, setDraft] = createSignal<string>()
  const [focused, setFocused] = createSignal(false)
  const length = () => parseLength(props.value)
  const unit = () => (/[a-z%]$/i.test(props.value.trim()) ? length()?.unit : undefined)

  const shown = () => {
    const current = draft()

    if (current !== undefined) return current
    const parsed = length()

    if (!parsed || focused()) return props.value

    return unit() ? String(Number(parsed.value.toFixed(2))) : props.value
  }

  const commit = (value: string) => {
    setDraft(undefined)
    const trimmed = value.trim()

    if (!trimmed || trimmed === props.value) return

    if (!PLAIN_NUMBER.test(trimmed) || props.unitless) return props.onCommit(trimmed)
    props.onCommit(`${trimmed}${unit() ?? "px"}`)
  }

  const nudge = (delta: number) => commit(step(props.value || "0", delta))

  const scrub = (event: PointerEvent) => {
    if (event.button !== 0 || !length()) return
    const start = { x: event.clientX, value: props.value }
    const move = (next: PointerEvent) => setDraft(step(start.value, Math.round((next.clientX - start.x) / 2)))

    const up = () => {
      window.removeEventListener("pointermove", move)
      window.removeEventListener("pointerup", up)
      document.documentElement.style.removeProperty("cursor")
      const value = draft()

      if (value) commit(value)
    }

    window.addEventListener("pointermove", move)
    window.addEventListener("pointerup", up)
    document.documentElement.style.setProperty("cursor", "ew-resize")
    event.preventDefault()
  }

  return (
    <div class="flex flex-col gap-1.5 min-w-0" classList={{ "col-span-2": props.wide }}>
      <Caption label={props.label} changed={props.changed} scrub={length() !== undefined} onPointerDown={scrub} />
      <div class={`${shell} h-8`}>
        <Show when={props.glyph}>
          <span
            class="flex items-center justify-center w-7 h-full shrink-0 text-v2-text-text-faint transition-colors group-focus-within/field:text-[#1a64d6]"
            classList={{ "cursor-ew-resize hover:text-v2-text-text-base": length() !== undefined }}
            onPointerDown={scrub}
          >
            {props.glyph}
          </span>
        </Show>
        <input
          class={`${bare} flex-1 w-full`}
          classList={{ "ps-2.5": !props.glyph }}
          value={shown()}
          spellcheck={false}
          aria-label={props.label}
          onFocus={() => setFocused(true)}
          onInput={(event) => setDraft(event.currentTarget.value)}
          onBlur={(event) => {
            setFocused(false)
            commit(event.currentTarget.value)
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur()

            if (event.key === "Escape") {
              setDraft(undefined)
              event.currentTarget.blur()
            }

            if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return
            event.preventDefault()
            commit(step(draft() ?? props.value, (event.key === "ArrowUp" ? 1 : -1) * (event.shiftKey ? 10 : 1)))
          }}
        />
        <Show when={!focused() && unit()}>
          <span class="pe-2 shrink-0 text-[11px] text-v2-text-text-faint select-none group-hover/field:hidden">{unit()}</span>
        </Show>
        <Show when={length() !== undefined}>
          <span class="hidden group-hover/field:flex group-focus-within/field:flex flex-col shrink-0 h-full w-4 me-0.5 py-1">
            <button
              type="button"
              tabIndex={-1}
              aria-hidden="true"
              class="flex flex-1 items-center justify-center rounded-t-sm text-v2-text-text-faint cursor-pointer hover:bg-v2-overlay-simple-overlay-hover hover:text-v2-text-text-base"
              onPointerDown={(event) => event.preventDefault()}
              onClick={(event) => nudge(event.shiftKey ? 10 : 1)}
            >
              <Chevron up />
            </button>
            <button
              type="button"
              tabIndex={-1}
              aria-hidden="true"
              class="flex flex-1 items-center justify-center rounded-b-sm text-v2-text-text-faint cursor-pointer hover:bg-v2-overlay-simple-overlay-hover hover:text-v2-text-text-base"
              onPointerDown={(event) => event.preventDefault()}
              onClick={(event) => nudge(event.shiftKey ? -10 : -1)}
            >
              <Chevron />
            </button>
          </span>
        </Show>
      </div>
    </div>
  )
}

const Chevron = (props: { up?: boolean }) => (
  <svg viewBox="0 0 8 5" width="7" height="5" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">
    <path d={props.up ? "M1 4 4 1l3 3" : "M1 1l3 3 3-3"} />
  </svg>
)

/**
 * A colour: the chip opens the system picker, the hex takes any CSS colour, the percentage is its opacity, and the
 * palette button shows the page's own colours.
 */
export function ColorField(props: {
  label: string
  value: string
  swatches: readonly string[]
  onCommit: (value: string) => void
  changed?: boolean
  labels: { opacity: string; palette: string; none: string; custom: string }
}) {
  const [draft, setDraft] = createSignal<string>()
  const [open, setOpen] = createSignal(false)
  const hex = () => toHex(props.value)
  const alpha = () => alphaOf(props.value)
  // A fully transparent colour reads as "no colour" rather than as black at 0%.
  const empty = () => alpha() === 0
  const text = () => draft() ?? (empty() ? "" : (hex()?.slice(1).toUpperCase() ?? props.value))

  const commit = (value: string) => {
    setDraft(undefined)
    const trimmed = value.trim()

    if (!trimmed) return
    const typed = /^[0-9a-f]{3}([0-9a-f]{3})?$/i.test(trimmed) ? `#${trimmed}` : trimmed
    const next = toHex(typed) && alpha() < 1 && alpha() > 0 && typed.startsWith("#") ? withAlpha(toHex(typed)!, alpha()) : typed

    if (next.toLowerCase() !== props.value.toLowerCase()) props.onCommit(next)
  }

  const commitAlpha = (value: string) => {
    const percent = Number.parseFloat(value)

    if (Number.isNaN(percent)) return
    const next = withAlpha(hex() ?? "#000000", Math.min(100, Math.max(0, percent)) / 100)

    if (next !== props.value) props.onCommit(next)
  }

  return (
    <div class="flex flex-col gap-1.5 min-w-0 col-span-2">
      <Caption label={props.label} changed={props.changed} />
      <div class={`${shell} h-8 ps-1.5`}>
        <label
          class="relative size-5 shrink-0 rounded-md overflow-hidden cursor-pointer shadow-[inset_0_0_0_1px_rgb(0_0_0/0.1)]"
          style={{ background: CHECKER }}
          title={props.labels.custom}
        >
          <span class="absolute inset-0" style={{ background: props.value }} />
          <input
            type="color"
            class="absolute inset-0 opacity-0 cursor-pointer"
            value={hex() ?? "#000000"}
            aria-label={props.labels.custom}
            onInput={(event) => props.onCommit(withAlpha(event.currentTarget.value, alpha() === 0 ? 1 : alpha()))}
          />
        </label>
        <span class="ps-2 text-[11px] text-v2-text-text-faint select-none" classList={{ hidden: hex() === undefined || empty() }}>
          #
        </span>
        <input
          class={`${bare} flex-1 w-full font-mono text-[11.5px] ${hex() === undefined || empty() ? "ps-2" : "ps-0.5 uppercase"}`}
          value={text()}
          placeholder={empty() ? props.labels.none : undefined}
          spellcheck={false}
          aria-label={props.label}
          onInput={(event) => setDraft(event.currentTarget.value)}
          onBlur={(event) => commit(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur()

            if (event.key === "Escape") {
              setDraft(undefined)
              event.currentTarget.blur()
            }
          }}
        />
        <span class="h-4 w-px shrink-0 bg-v2-border-border-base" />
        <input
          class={`${bare} w-11 shrink-0 pe-0.5 text-end`}
          value={empty() ? "" : `${Math.round(alpha() * 100)}%`}
          placeholder="—"
          spellcheck={false}
          aria-label={props.labels.opacity}
          onFocus={(event) => event.currentTarget.select()}
          onBlur={(event) => commitAlpha(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur()

            if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return
            event.preventDefault()
            commitAlpha(String(alpha() * 100 + (event.key === "ArrowUp" ? 1 : -1) * (event.shiftKey ? 10 : 1)))
          }}
        />
        <button
          type="button"
          title={props.labels.palette}
          aria-label={props.labels.palette}
          aria-expanded={open()}
          class="flex items-center justify-center size-6 mx-1 shrink-0 rounded-md cursor-pointer transition-colors"
          classList={{
            "bg-[#1a64d6]/15 text-[#1a64d6]": open(),
            "text-v2-text-text-faint hover:text-v2-text-text-base hover:bg-v2-overlay-simple-overlay-hover": !open(),
          }}
          onClick={() => setOpen((value) => !value)}
        >
          <Palette />
        </button>
      </div>
      <Show when={open()}>
        <div class="grid grid-cols-[repeat(auto-fill,minmax(22px,1fr))] gap-1.5 p-2 rounded-lg bg-v2-overlay-simple-overlay-hover">
          <Swatch color="transparent" title={props.labels.none} active={alpha() === 0} onPick={() => props.onCommit("transparent")} />
          <For each={props.swatches.slice(0, 23)}>
            {(color) => (
              <Swatch
                color={color}
                title={color}
                active={alpha() > 0 && toHex(color) === hex() && alphaOf(color) === alpha()}
                onPick={() => props.onCommit(color)}
              />
            )}
          </For>
        </div>
      </Show>
    </div>
  )
}

function Swatch(props: { color: string; title: string; active: boolean; onPick: () => void }) {
  return (
    <button
      type="button"
      title={props.title}
      aria-label={props.title}
      aria-pressed={props.active}
      class="relative aspect-square w-full rounded-md overflow-hidden cursor-pointer transition-transform hover:scale-110 shadow-[inset_0_0_0_1px_rgb(0_0_0/0.1)]"
      classList={{ "shadow-[0_0_0_2px_var(--v2-background-bg-base),0_0_0_3.5px_#1a64d6]": props.active }}
      style={{ background: CHECKER }}
      onClick={() => props.onPick()}
    >
      <span class="absolute inset-0" style={{ background: props.color }} />
      <Show when={props.color === "transparent"}>
        <span class="absolute left-1/2 top-[-20%] h-[140%] w-[1.5px] -translate-x-1/2 rotate-45 bg-v2-state-fg-danger" />
      </Show>
    </button>
  )
}

/** A choice among a few options, as one row of buttons; an option with a glyph shows the glyph, else its label. */
export function Segmented<T extends string>(props: {
  label: string
  value: string
  options: readonly { value: T; label: string; glyph?: () => JSX.Element }[]
  onCommit: (value: T) => void
  changed?: boolean
  wide?: boolean
}) {
  return (
    <div class="flex flex-col gap-1.5 min-w-0" classList={{ "col-span-2": props.wide ?? true }}>
      <Caption label={props.label} changed={props.changed} />
      <div class="flex gap-0.5 h-8 p-0.5 rounded-lg bg-v2-overlay-simple-overlay-hover" role="radiogroup" aria-label={props.label}>
        <For each={props.options}>
          {(option) => (
            <button
              type="button"
              role="radio"
              title={option.label}
              aria-label={option.label}
              aria-checked={props.value === option.value}
              class="flex flex-1 min-w-0 items-center justify-center rounded-md px-1 text-[11.5px] cursor-pointer transition-[background-color,color,box-shadow] duration-150"
              classList={{
                "bg-v2-background-bg-base text-v2-text-text-base font-[500] shadow-[0_1px_2px_rgb(0_0_0/0.1),0_0_0_0.5px_rgb(0_0_0/0.06)]":
                  props.value === option.value,
                "text-v2-text-text-muted hover:text-v2-text-text-base": props.value !== option.value,
              }}
              onClick={() => props.onCommit(option.value)}
            >
              <Show when={option.glyph} fallback={<span class="truncate">{option.label}</span>}>
                {(glyph) => glyph()()}
              </Show>
            </button>
          )}
        </For>
      </div>
    </div>
  )
}

type Option = { value: string; label: string }

/** A choice among many options; `groups` adds labelled groups of options after the ungrouped ones. */
export function SelectField(props: {
  label: string
  value: string
  options: readonly Option[]
  groups?: readonly { label: string; options: readonly Option[] }[]
  onCommit: (value: string) => void
  wide?: boolean
  changed?: boolean
}) {
  const known = () => [...props.options, ...(props.groups ?? []).flatMap((group) => group.options)]

  return (
    <Field label={props.label} wide={props.wide} changed={props.changed}>
      <div class={`${shell} h-8`}>
        <select
          class={`${bare} w-full appearance-none ps-2.5 pe-7 cursor-pointer truncate`}
          value={props.value}
          onChange={(event) => props.onCommit(event.currentTarget.value)}
        >
          <Show when={!known().some((option) => option.value === props.value)}>
            <option value={props.value}>{props.value}</option>
          </Show>
          <For each={props.options}>{(option) => <option value={option.value}>{option.label}</option>}</For>
          <For each={props.groups ?? []}>
            {(group) => (
              <optgroup label={group.label}>
                <For each={group.options}>{(option) => <option value={option.value}>{option.label}</option>}</For>
              </optgroup>
            )}
          </For>
        </select>
        <Icon name="chevron-down" size="small" class="pointer-events-none absolute end-1.5 text-v2-text-text-faint" />
      </div>
    </Field>
  )
}

/** One line of text, committed on Enter or leaving the field. */
export function TextField(props: { label: string; value: string; onCommit: (value: string) => void; changed?: boolean; placeholder?: string }) {
  const commit = (value: string) => value !== props.value && props.onCommit(value)

  return (
    <Field label={props.label} wide changed={props.changed}>
      <div class={`${shell} h-8`}>
        <input
          class={`${bare} w-full px-2.5`}
          value={props.value}
          placeholder={props.placeholder}
          spellcheck={false}
          onBlur={(event) => commit(event.currentTarget.value)}
          onKeyDown={(event) => event.key === "Enter" && event.currentTarget.blur()}
        />
      </div>
    </Field>
  )
}

/** Several lines of text, committed on ⌘/Ctrl+Enter or leaving the field. */
export function TextArea(props: { label: string; value: string; onCommit: (value: string) => void; changed?: boolean; hint: string }) {
  const commit = (value: string) => value !== props.value && props.onCommit(value)

  return (
    <Field label={props.label} wide changed={props.changed}>
      <div class={`${shell} flex-col items-stretch`}>
        <textarea
          rows={3}
          class="w-full min-w-0 resize-y bg-transparent px-2.5 pt-2 pb-1 text-12-regular leading-[1.5] text-v2-text-text-base outline-none"
          value={props.value}
          onBlur={(event) => commit(event.currentTarget.value)}
          onKeyDown={(event) => (event.metaKey || event.ctrlKey) && event.key === "Enter" && event.currentTarget.blur()}
        />
        <span class="px-2.5 pb-1.5 text-[10.5px] text-v2-text-text-faint select-none">{props.hint}</span>
      </div>
    </Field>
  )
}

type Side = "top" | "right" | "bottom" | "left"

const SIDES: readonly Side[] = ["top", "right", "bottom", "left"]

/**
 * Margin outside, padding inside, each side editable, around the element's size. The link toggle sets all four sides
 * of one ring at once.
 */
export function BoxModel(props: {
  styles: Record<string, string>
  changed: (property: string) => boolean
  labels: { margin: string; padding: string; linked: string }
  onCommit: (property: string, value: string) => void
}) {
  const [linked, setLinked] = createSignal({ margin: false, padding: false })

  const set = (ring: "margin" | "padding", side: Side, value: string) => {
    const trimmed = value.trim()

    if (!trimmed) return
    const css = PLAIN_NUMBER.test(trimmed) ? `${trimmed}px` : trimmed
    const sides = linked()[ring] ? SIDES : [side]
    sides.filter((item) => props.styles[`${ring}-${item}`] !== css).forEach((item) => props.onCommit(`${ring}-${item}`, css))
  }

  const cell = (ring: "margin" | "padding", side: Side, extra: string) => (
    <input
      class={`absolute ${extra} w-9 h-5 rounded-md bg-transparent text-center text-[11px] tabular-nums outline-none transition-colors hover:bg-v2-background-bg-base/70 focus:bg-v2-background-bg-base focus:shadow-[0_0_0_1.5px_#1a64d6]`}
      classList={{
        "text-[#1a64d6] font-[600]": props.changed(`${ring}-${side}`),
        "text-v2-text-text-base": !props.changed(`${ring}-${side}`) && parseLength(props.styles[`${ring}-${side}`] ?? "")?.value !== 0,
        "text-v2-text-text-faint": !props.changed(`${ring}-${side}`) && parseLength(props.styles[`${ring}-${side}`] ?? "")?.value === 0,
      }}
      value={(props.styles[`${ring}-${side}`] ?? "").replace(/px$/, "")}
      aria-label={`${ring === "margin" ? props.labels.margin : props.labels.padding} ${side}`}
      spellcheck={false}
      onFocus={(event) => event.currentTarget.select()}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur()

        if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return
        event.preventDefault()
        set(ring, side, step(props.styles[`${ring}-${side}`] || "0px", (event.key === "ArrowUp" ? 1 : -1) * (event.shiftKey ? 10 : 1)))
      }}
      onBlur={(event) => set(ring, side, event.currentTarget.value)}
    />
  )

  const ringLabel = (ring: "margin" | "padding") => (
    <span class="absolute left-2 top-1.5 flex items-center gap-1">
      <span class="text-[9.5px] font-[600] uppercase tracking-[0.08em] text-v2-text-text-faint select-none">
        {ring === "margin" ? props.labels.margin : props.labels.padding}
      </span>
      <button
        type="button"
        title={props.labels.linked}
        aria-label={`${props.labels.linked}: ${ring === "margin" ? props.labels.margin : props.labels.padding}`}
        aria-pressed={linked()[ring]}
        class="flex items-center justify-center size-4 rounded-sm cursor-pointer transition-colors"
        classList={{
          "bg-[#1a64d6]/15 text-[#1a64d6]": linked()[ring],
          "text-v2-text-text-faint hover:text-v2-text-text-base": !linked()[ring],
        }}
        onClick={() => setLinked((current) => ({ ...current, [ring]: !current[ring] }))}
      >
        <Link />
      </button>
    </span>
  )

  return (
    <div class="relative col-span-2 h-[164px] rounded-xl bg-v2-overlay-simple-overlay-hover shadow-[inset_0_0_0_1px_var(--v2-border-border-base)] [background-image:repeating-linear-gradient(135deg,transparent_0_6px,rgb(0_0_0/0.025)_6px_7px)]">
      {ringLabel("margin")}
      {cell("margin", "top", "left-1/2 -translate-x-1/2 top-1.5")}
      {cell("margin", "bottom", "left-1/2 -translate-x-1/2 bottom-1.5")}
      {cell("margin", "left", "left-1.5 top-1/2 -translate-y-1/2")}
      {cell("margin", "right", "right-1.5 top-1/2 -translate-y-1/2")}
      <div class="absolute inset-x-12 inset-y-8 rounded-lg bg-[#1a64d6]/[0.07] shadow-[inset_0_0_0_1px_rgb(26_100_214/0.25)]">
        {ringLabel("padding")}
        {cell("padding", "top", "left-1/2 -translate-x-1/2 top-1.5")}
        {cell("padding", "bottom", "left-1/2 -translate-x-1/2 bottom-1.5")}
        {cell("padding", "left", "left-1 top-1/2 -translate-y-1/2")}
        {cell("padding", "right", "right-1 top-1/2 -translate-y-1/2")}
        <div class="absolute inset-x-11 inset-y-8 rounded-md bg-v2-background-bg-base shadow-[0_1px_2px_rgb(0_0_0/0.08),inset_0_0_0_1px_var(--v2-border-border-base)] flex items-center justify-center text-[10.5px] tabular-nums text-v2-text-text-muted">
          {Math.round(parseLength(props.styles.width ?? "")?.value ?? 0)} × {Math.round(parseLength(props.styles.height ?? "")?.value ?? 0)}
        </div>
      </div>
    </div>
  )
}
