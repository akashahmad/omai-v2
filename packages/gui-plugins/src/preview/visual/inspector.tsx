// The visual editor's inspector. It covers the chat timeline while visual editing is on: the selected element's
// content and styles on top, the pending changes and Save at the bottom. Every edit goes to the editor in the page,
// which applies it live and reports it back as a pending change.

import { createMemo, createSignal, For, Match, onCleanup, Show, Switch, type JSX } from "solid-js"
import { createKeyed, usePlugin } from "@opencode/plugin/gui"
import { Icon } from "@opencode/ui/icon"
import { Loader } from "@opencode/ui/loader"
import { Tooltip } from "@opencode/ui/tooltip"
import type { PreviewView } from "../view"
import { grouped } from "./changes"
import { BoxModel, ColorField, NumberField, Segmented, SelectField, TextArea, TextField } from "./fields"
import {
  AlignCenter,
  AlignJustify,
  AlignLeft,
  AlignRight,
  BorderWidth,
  Column,
  FontSize,
  Gap,
  LetterSpacing,
  Letters,
  LineHeight,
  Opacity,
  Radius,
  Row,
} from "./glyphs"
import type { ElementInfo, LiveChange } from "./protocol"
import { sameShadow } from "./units"

const SHADOW_KEYS = ["none", "small", "medium", "large"] as const

const SHADOWS = {
  none: "none",
  small: "0 1px 2px rgb(0 0 0 / 0.08)",
  medium: "0 4px 12px rgb(0 0 0 / 0.12)",
  large: "0 12px 32px rgb(0 0 0 / 0.18)",
} as const

// Web-safe stacks; `key` names the ones whose first family isn't a name people know.
const COMMON_FONTS = [
  { value: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif', key: "visual.font.system" },
  { value: "Arial, Helvetica, sans-serif" },
  { value: '"Helvetica Neue", Helvetica, Arial, sans-serif' },
  { value: "Verdana, Geneva, sans-serif" },
  { value: "Tahoma, Geneva, sans-serif" },
  { value: '"Trebuchet MS", Helvetica, sans-serif' },
  { value: "Georgia, serif" },
  { value: '"Times New Roman", Times, serif' },
  { value: 'Garamond, "Times New Roman", serif' },
  { value: '"Courier New", Courier, monospace' },
  { value: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace", key: "visual.font.mono" },
]

const brand =
  "inline-flex items-center justify-center gap-1.5 h-8 px-3.5 rounded-lg bg-[#0a3a78] text-[#fff] text-12-medium cursor-pointer transition-colors hover:bg-[#082f62] disabled:opacity-50 disabled:cursor-default"

const quiet =
  "inline-flex items-center justify-center gap-1.5 h-8 px-3 rounded-lg text-12-medium text-v2-text-text-base cursor-pointer transition-colors hover:bg-v2-overlay-simple-overlay-hover disabled:opacity-40 disabled:cursor-default"

const groupButton =
  "flex items-center justify-center size-6 rounded-md text-v2-text-text-muted cursor-pointer transition-colors hover:bg-v2-background-bg-base hover:text-v2-text-text-base hover:shadow-[0_1px_2px_rgb(0_0_0/0.08)]"

const iconButton =
  "flex shrink-0 items-center justify-center size-7 rounded-md text-v2-text-text-muted cursor-pointer transition-colors hover:bg-v2-overlay-simple-overlay-hover hover:text-v2-text-text-base disabled:opacity-40 disabled:cursor-default"

export default function Inspector(props: { view: PreviewView }) {
  const ctx = usePlugin()
  const visual = props.view.visual
  // Which sections are folded; kept across selections so the inspector doesn't reflow on every click.
  const [folded, setFolded] = createSignal<ReadonlySet<string>>(new Set(["border", "effects"]))

  const sections = {
    open: (id: string) => !folded().has(id),
    toggle: (id: string) =>
      setFolded((current) => {
        const next = new Set(current)

        if (!next.delete(id)) next.add(id)

        return next
      }),
  }

  return (
    <div
      data-component="visual-inspector"
      class="flex flex-col h-full min-h-0 bg-v2-background-bg-base"
      onKeyDown={(event) => {
        const typing = event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement

        if (event.key === "Escape" && !typing) visual.exit()

        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z" && !typing) {
          event.preventDefault()

          if (event.shiftKey) visual.redo()
          else visual.undo()
        }
      }}
    >
      <div class="flex items-center gap-2.5 h-12 shrink-0 px-4 border-b border-v2-border-border-base">
        <span class="flex items-center justify-center size-6 rounded-md bg-[#1a64d6]/15 text-[#1a64d6]">
          <Icon name="select-element" size="small" />
        </span>
        <span class="text-14-medium text-v2-text-text-base">{ctx.t("visual.title")}</span>
        <span class="flex items-center gap-1.5 px-2 h-5 rounded-full bg-[#22c55e]/12 text-[10.5px] font-[500] text-[color-mix(in_srgb,#16a34a_85%,var(--v2-text-text-base))]">
          <span class="size-1.5 rounded-full bg-[#22c55e] animate-pulse" />
          {ctx.t("visual.live")}
        </span>
        <span class="flex-1" />
        <Tooltip value={ctx.t("visual.close")} placement="bottom">
          <button type="button" class={iconButton} aria-label={ctx.t("visual.close")} onClick={() => visual.exit()}>
            <Icon name="close" size="small" />
          </button>
        </Tooltip>
      </div>

      <div class="flex-1 min-h-0 overflow-y-auto overscroll-contain">
        <Show when={visual.selected()} keyed fallback={<Empty />}>
          {(element) => <ElementPanel view={props.view} element={element} sections={sections} />}
        </Show>
      </div>

      <Footer view={props.view} />
    </div>
  )
}

function Empty() {
  const ctx = usePlugin()

  return (
    <div class="flex flex-col items-center justify-center gap-4 h-full px-8 text-center">
      <span class="flex items-center justify-center size-14 rounded-2xl bg-[#1a64d6]/10 text-[#1a64d6] shadow-[inset_0_0_0_1px_rgb(26_100_214/0.2)]">
        <Icon name="select-element" />
      </span>
      <div class="flex flex-col gap-1.5">
        <div class="text-14-medium text-v2-text-text-base">{ctx.t("visual.empty.title")}</div>
        <p class="text-[13px] leading-[1.5] text-v2-text-text-muted max-w-[280px]">{ctx.t("visual.empty.body")}</p>
      </div>
      <div class="flex flex-col gap-1.5 w-full max-w-[260px] pt-1">
        <Hint keys="Click" label={ctx.t("visual.hint.select")} />
        <Hint keys="2× Click" label={ctx.t("visual.hint.edit")} />
        <Hint keys="⌥ ↑ ↓" label={ctx.t("visual.hint.move")} />
        <Hint keys="Esc" label={ctx.t("visual.hint.exit")} />
      </div>
    </div>
  )
}

function Hint(props: { keys: string; label: string }) {
  return (
    <div class="flex items-center justify-between gap-3 text-[12px]">
      <span class="text-v2-text-text-muted">{props.label}</span>
      <kbd class="px-1.5 h-5 flex items-center rounded-md bg-v2-overlay-simple-overlay-hover shadow-[inset_0_-1px_0_var(--v2-border-border-base)] font-mono text-[10.5px] text-v2-text-text-base">
        {props.keys}
      </kbd>
    </div>
  )
}

type Sections = { open: (id: string) => boolean; toggle: (id: string) => void }

const SECTION_KEYS = {
  content: ["text", "href", "src", "alt"],
  typography: ["font-family", "font-size", "font-weight", "line-height", "letter-spacing", "text-align", "color"],
  fill: ["background-color"],
  spacing: ["top", "right", "bottom", "left"].flatMap((side) => [`margin-${side}`, `padding-${side}`]),
  size: ["width", "height", "min-width", "max-width"],
  layout: ["flex-direction", "flex-wrap", "gap", "align-items", "justify-content"],
  border: ["border-width", "border-style", "border-color", "border-radius"],
  effects: ["opacity", "box-shadow"],
} satisfies Record<string, readonly string[]>

function ElementPanel(props: { view: PreviewView; element: ElementInfo; sections: Sections }) {
  const ctx = usePlugin()
  const visual = props.view.visual
  // The element object is replaced on every report, so read styles through the live selection.
  const styles = () => visual.selected()?.styles ?? props.element.styles
  const style = (key: string) => styles()[key] ?? ""

  // The properties of this element with a pending change; a text edit counts as `text`.
  const changed = createMemo(
    () =>
      new Set(
        visual
          .pending()
          .items.filter((item) => item.path === props.element.path)
          .map((item) => item.property ?? item.kind),
      ),
  )

  const bind = (property: string) => ({
    get value() {
      return style(property)
    },
    get changed() {
      return changed().has(property)
    },
    onCommit: (value: string) => visual.style(property, value),
  })

  const section = (id: keyof typeof SECTION_KEYS) => ({
    id,
    get open() {
      return props.sections.open(id)
    },
    get changed() {
      return SECTION_KEYS[id].some((key) => changed().has(key))
    },
    onToggle: () => props.sections.toggle(id),
  })

  const weights = ["300", "400", "500", "600", "700", "800"].map((value) => ({ value, label: ctx.t(`visual.weight.${value}`) }))

  const family = (value: string) => value.split(",")[0]!.trim().replace(/["']/g, "")

  // The page's own fonts first, then web-safe stacks that render the same everywhere without loading anything.
  const fonts = () => {
    const page = [...new Set([style("font-family"), ...visual.fonts()])].filter(Boolean)
    const used = new Set(page.map((value) => family(value).toLowerCase()))
    const common = COMMON_FONTS.filter((font) => !used.has(family(font.value).toLowerCase()))

    return [
      { label: ctx.t("visual.font.page"), options: page.map((value) => ({ value, label: family(value) })) },
      {
        label: ctx.t("visual.font.common"),
        options: common.map((font) => ({ value: font.value, label: font.key ? ctx.t(font.key) : family(font.value) })),
      },
    ].filter((group) => group.options.length > 0)
  }

  const options = (values: readonly [string, string][]) => values.map(([value, key]) => ({ value, label: ctx.t(key) }))

  const colorLabels = () => ({
    opacity: ctx.t("visual.opacity"),
    palette: ctx.t("visual.colorPalette"),
    none: ctx.t("visual.colorNone"),
    custom: ctx.t("visual.colorCustom"),
  })

  const container = () => props.element.layout === "flex" || props.element.layout === "grid"
  const file = () => props.element.source?.file?.split("/").at(-1)

  return (
    <div class="flex flex-col">
      <div class="sticky top-0 z-10 flex flex-col gap-2.5 px-4 pt-3.5 pb-3 bg-v2-background-bg-base/95 backdrop-blur-sm border-b border-v2-border-border-base">
        <div class="flex items-center gap-2.5 min-w-0">
          <span class="flex items-center justify-center min-w-8 h-8 px-1.5 shrink-0 rounded-lg bg-[#1a64d6]/12 text-[#1a64d6] shadow-[inset_0_0_0_1px_rgb(26_100_214/0.2)] font-mono text-[11px] font-[600]">
            {props.element.tag}
          </span>
          <div class="flex flex-col min-w-0 flex-1">
            <span class="text-[13px] font-[500] leading-[1.3] text-v2-text-text-base truncate">
              {props.element.source?.component ?? props.element.label}
            </span>
            <span class="text-[11px] leading-[1.3] text-v2-text-text-muted truncate" title={props.element.source?.file}>
              <Show when={file()} fallback={`${Math.round(props.element.rect.width)} × ${Math.round(props.element.rect.height)}`}>
                {file()}
                <Show when={props.element.source?.line}>{(line) => `:${line()}`}</Show>
              </Show>
            </span>
          </div>
          <div class="flex items-center shrink-0 p-0.5 gap-0.5 rounded-lg bg-v2-overlay-simple-overlay-hover">
            <Tooltip value={ctx.t("visual.move.up")} placement="bottom">
              <button type="button" class={groupButton} aria-label={ctx.t("visual.move.up")} onClick={() => visual.move(-1)}>
                <Icon name="arrow-up" size="small" />
              </button>
            </Tooltip>
            <Tooltip value={ctx.t("visual.move.down")} placement="bottom">
              <button type="button" class={groupButton} aria-label={ctx.t("visual.move.down")} onClick={() => visual.move(1)}>
                <Icon name="arrow-up" size="small" class="rotate-180" />
              </button>
            </Tooltip>
          </div>
        </div>
        <div class="flex items-center gap-1.5 min-w-0">
          <nav
            class="flex flex-1 items-center gap-0.5 min-w-0 overflow-x-auto [scrollbar-width:none] text-[11px]"
            aria-label={ctx.t("visual.parent")}
            ref={(element) => queueMicrotask(() => (element.scrollLeft = element.scrollWidth))}
          >
            <For each={props.element.breadcrumb}>
              {(crumb, index) => (
                <>
                  <Show when={index() > 0}>
                    <Icon name="chevron-right" size="small" class="shrink-0 text-v2-text-text-faint" />
                  </Show>
                  <button
                    type="button"
                    class="shrink-0 px-1.5 h-5 rounded-md font-mono cursor-pointer transition-colors"
                    classList={{
                      "bg-[#1a64d6]/12 text-[#1a64d6] font-[500]": index() === props.element.breadcrumb.length - 1,
                      "text-v2-text-text-muted hover:text-v2-text-text-base hover:bg-v2-overlay-simple-overlay-hover":
                        index() !== props.element.breadcrumb.length - 1,
                    }}
                    onClick={() => visual.selectPath(crumb.path)}
                  >
                    {crumb.label}
                  </button>
                </>
              )}
            </For>
          </nav>
          <Tooltip value={ctx.t("visual.ask")} placement="bottom">
            <button
              type="button"
              class="flex shrink-0 items-center gap-1 h-6 px-2 rounded-md bg-[#1a64d6]/12 text-[11.5px] font-[500] text-[color-mix(in_srgb,#1a64d6_85%,var(--v2-text-text-base))] cursor-pointer transition-colors hover:bg-[#1a64d6]/20"
              onClick={() => {
                const element = visual.selected()

                if (element) visual.ask(element)
              }}
            >
              <Icon name="outline-brain" size="small" />
              {ctx.t("visual.tool.ask")}
            </button>
          </Tooltip>
        </div>
      </div>

      <Show when={props.element.isText || props.element.isImage || props.element.href !== undefined}>
        <Section {...section("content")} title={ctx.t("visual.section.content")}>
          <Show when={props.element.isText}>
            <Show
              when={props.element.plainText}
              fallback={
                <p class="col-span-2 flex gap-2 p-2.5 rounded-lg bg-v2-overlay-simple-overlay-hover text-[12px] leading-[1.5] text-v2-text-text-muted">
                  <Icon name="info" size="small" class="shrink-0 mt-px" />
                  {ctx.t("visual.text.mixed")}
                </p>
              }
            >
              <TextArea
                label={ctx.t("visual.text")}
                hint={ctx.t("visual.text.hint")}
                value={visual.selected()?.text ?? ""}
                changed={changed().has("text")}
                onCommit={(value) => visual.text(value)}
              />
            </Show>
          </Show>
          <Show when={props.element.href !== undefined}>
            <TextField
              label={ctx.t("visual.link")}
              value={visual.selected()?.href ?? ""}
              placeholder="https://"
              changed={changed().has("href")}
              onCommit={(value) => visual.attribute("href", value)}
            />
          </Show>
          <Show when={props.element.isImage}>
            <div class="col-span-2 flex items-center gap-3 p-2 rounded-xl bg-v2-overlay-simple-overlay-hover">
              <img
                src={visual.selected()?.srcUrl ?? visual.selected()?.src}
                alt=""
                class="size-14 shrink-0 rounded-lg object-cover bg-v2-background-bg-base shadow-[inset_0_0_0_1px_var(--v2-border-border-base)]"
              />
              <div class="flex flex-col gap-1.5 min-w-0">
                <span class="text-[11px] text-v2-text-text-muted truncate">{visual.selected()?.src?.split("/").at(-1)?.split("?")[0]}</span>
                <button
                  type="button"
                  class="self-start inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md bg-v2-background-bg-base text-12-medium text-v2-text-text-base cursor-pointer shadow-[0_1px_2px_rgb(0_0_0/0.06),inset_0_0_0_1px_var(--v2-border-border-base)] transition-colors hover:bg-v2-overlay-simple-overlay-hover"
                  onClick={() => {
                    const element = visual.selected()

                    if (element) visual.image(element)
                  }}
                >
                  <Icon name="photo" size="small" />
                  {ctx.t("visual.image.replace")}
                </button>
              </div>
            </div>
            <TextField
              label={ctx.t("visual.alt")}
              value={visual.selected()?.alt ?? ""}
              changed={changed().has("alt")}
              onCommit={(value) => visual.attribute("alt", value)}
            />
          </Show>
        </Section>
      </Show>

      <Show when={props.element.isText}>
        <Section {...section("typography")} title={ctx.t("visual.section.typography")}>
          <SelectField label={ctx.t("visual.font")} options={[]} groups={fonts()} {...bind("font-family")} wide />
          <NumberField label={ctx.t("visual.fontSize")} glyph={<FontSize />} {...bind("font-size")} />
          <SelectField label={ctx.t("visual.weight")} options={weights} {...bind("font-weight")} />
          <NumberField label={ctx.t("visual.lineHeight")} glyph={<LineHeight />} unitless {...bind("line-height")} />
          <NumberField label={ctx.t("visual.letterSpacing")} glyph={<LetterSpacing />} {...bind("letter-spacing")} />
          <Segmented
            label={ctx.t("visual.align")}
            options={[
              { value: "left", label: ctx.t("visual.align.left"), glyph: AlignLeft },
              { value: "center", label: ctx.t("visual.align.center"), glyph: AlignCenter },
              { value: "right", label: ctx.t("visual.align.right"), glyph: AlignRight },
              { value: "justify", label: ctx.t("visual.align.justify"), glyph: AlignJustify },
            ]}
            {...bind("text-align")}
          />
          <ColorField label={ctx.t("visual.color")} swatches={visual.colors()} labels={colorLabels()} {...bind("color")} />
        </Section>
      </Show>

      <Section {...section("fill")} title={ctx.t("visual.section.fill")}>
        <ColorField label={ctx.t("visual.background")} swatches={visual.colors()} labels={colorLabels()} {...bind("background-color")} />
      </Section>

      <Section {...section("spacing")} title={ctx.t("visual.section.spacing")}>
        <BoxModel
          styles={styles()}
          changed={(property) => changed().has(property)}
          labels={{ margin: ctx.t("visual.margin"), padding: ctx.t("visual.padding"), linked: ctx.t("visual.linked") }}
          onCommit={(property, value) => visual.style(property, value)}
        />
      </Section>

      <Section {...section("size")} title={ctx.t("visual.section.size")}>
        <NumberField label={ctx.t("visual.width")} glyph={<Letters text="W" />} {...bind("width")} />
        <NumberField label={ctx.t("visual.height")} glyph={<Letters text="H" />} {...bind("height")} />
        <NumberField label={ctx.t("visual.minWidth")} glyph={<Letters text="MIN" />} {...bind("min-width")} />
        <NumberField label={ctx.t("visual.maxWidth")} glyph={<Letters text="MAX" />} {...bind("max-width")} />
      </Section>

      <Show when={container()}>
        <Section {...section("layout")} title={ctx.t("visual.section.layout")}>
          <Show when={props.element.layout === "flex"}>
            <Segmented
              label={ctx.t("visual.direction")}
              wide={false}
              options={[
                { value: "row", label: ctx.t("visual.direction.row"), glyph: Row },
                { value: "column", label: ctx.t("visual.direction.column"), glyph: Column },
              ]}
              {...bind("flex-direction")}
            />
            <Segmented
              label={ctx.t("visual.wrap")}
              wide={false}
              options={options([
                ["nowrap", "visual.wrap.nowrap"],
                ["wrap", "visual.wrap.wrap"],
              ])}
              {...bind("flex-wrap")}
            />
          </Show>
          <NumberField label={ctx.t("visual.gap")} glyph={<Gap />} {...bind("gap")} />
          <SelectField
            label={ctx.t("visual.alignItems")}
            options={options([
              ["flex-start", "visual.option.start"],
              ["center", "visual.option.center"],
              ["flex-end", "visual.option.end"],
              ["stretch", "visual.option.stretch"],
            ])}
            {...bind("align-items")}
          />
          <SelectField
            label={ctx.t("visual.justify")}
            options={options([
              ["flex-start", "visual.option.start"],
              ["center", "visual.option.center"],
              ["flex-end", "visual.option.end"],
              ["space-between", "visual.option.between"],
            ])}
            {...bind("justify-content")}
            wide
          />
        </Section>
      </Show>

      <Section {...section("border")} title={ctx.t("visual.section.border")}>
        <NumberField label={ctx.t("visual.borderWidth")} glyph={<BorderWidth />} {...bind("border-width")} />
        <SelectField
          label={ctx.t("visual.borderStyle")}
          options={options([
            ["none", "visual.borderStyle.none"],
            ["solid", "visual.borderStyle.solid"],
            ["dashed", "visual.borderStyle.dashed"],
            ["dotted", "visual.borderStyle.dotted"],
          ])}
          {...bind("border-style")}
        />
        <ColorField label={ctx.t("visual.borderColor")} swatches={visual.colors()} labels={colorLabels()} {...bind("border-color")} />
        <NumberField label={ctx.t("visual.radius")} glyph={<Radius />} {...bind("border-radius")} wide />
      </Section>

      <Section {...section("effects")} title={ctx.t("visual.section.effects")}>
        <NumberField label={ctx.t("visual.opacity")} glyph={<Opacity />} unitless {...bind("opacity")} wide />
        <Segmented
          label={ctx.t("visual.shadow")}
          options={SHADOW_KEYS.map((key) => ({ value: SHADOWS[key], label: ctx.t(`visual.shadow.${key}`) }))}
          {...bind("box-shadow")}
          value={Object.values(SHADOWS).find((value) => sameShadow(value, style("box-shadow"))) ?? ""}
        />
      </Section>
    </div>
  )
}

/** A foldable group of fields; the dot says it holds a pending change, so a folded section still shows it. */
function Section(props: { id: string; title: string; open: boolean; changed: boolean; onToggle: () => void; children: JSX.Element }) {
  return (
    <section class="border-b border-v2-border-border-base last:border-b-0" data-section={props.id}>
      <button
        type="button"
        class="group flex items-center gap-2 w-full h-11 px-4 cursor-pointer select-none"
        aria-expanded={props.open}
        onClick={() => props.onToggle()}
      >
        <span class="text-[12px] font-[600] tracking-[0.01em] text-v2-text-text-base">{props.title}</span>
        <Show when={props.changed}>
          <span class="size-1.5 rounded-full bg-[#1a64d6] shadow-[0_0_0_3px_rgb(26_100_214/0.15)]" />
        </Show>
        <span class="ms-auto flex items-center justify-center size-6 rounded-md text-v2-text-text-faint transition-colors group-hover:bg-v2-overlay-simple-overlay-hover group-hover:text-v2-text-text-base">
          <Icon name="chevron-down" size="small" class="transition-transform duration-200" classList={{ "-rotate-90": !props.open }} />
        </span>
      </button>
      <div
        class="grid transition-[grid-template-rows,opacity] duration-200 ease-out"
        classList={{ "grid-rows-[1fr] opacity-100": props.open, "grid-rows-[0fr] opacity-0": !props.open }}
        inert={props.open ? undefined : true}
      >
        <div class="min-h-0 overflow-hidden">
          <div class="grid grid-cols-2 gap-x-2.5 gap-y-3.5 px-4 pt-0.5 pb-4">{props.children}</div>
        </div>
      </div>
    </section>
  )
}

function Footer(props: { view: PreviewView }) {
  const ctx = usePlugin()
  const visual = props.view.visual
  const [open, setOpen] = createSignal(false)
  const [confirming, setConfirming] = createSignal(false)
  const [now, setNow] = createSignal(Date.now())
  const count = () => visual.pending().items.length
  const working = () => visual.saving() === "sending" || visual.saving() === "working"

  // The elapsed time while the agent works on a save.
  createKeyed(working, () => {
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    onCleanup(() => clearInterval(timer))
  })

  const elapsed = () => {
    const seconds = Math.max(0, Math.floor((now() - (visual.startedAt() ?? now())) / 1000))

    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`
  }

  return (
    <div class="shrink-0 border-t border-v2-border-border-base bg-v2-background-bg-base">
      <Show when={open() && count() > 0}>
        <div class="max-h-48 overflow-y-auto px-4 pt-3 flex flex-col gap-2">
          <For each={grouped(visual.pending().items)}>
            {(group) => (
              <div class="flex flex-col gap-1">
                <code class="font-mono text-[11px] text-v2-text-text-muted truncate">{describe(group.changes[0]!)}</code>
                <For each={group.changes}>
                  {(change) => (
                    <div class="group flex items-center gap-2 text-[12px] min-w-0">
                      <span class="truncate text-v2-text-text-base">{summary(change, ctx.t)}</span>
                      <button
                        type="button"
                        class="ms-auto shrink-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 text-v2-text-text-faint hover:text-v2-text-text-base cursor-pointer"
                        aria-label={ctx.t("visual.change.remove")}
                        title={ctx.t("visual.change.remove")}
                        onClick={() => visual.removeAt(visual.pending().items.indexOf(change))}
                      >
                        <Icon name="outline-undo" size="small" />
                      </button>
                    </div>
                  )}
                </For>
              </div>
            )}
          </For>
        </div>
      </Show>

      <Switch>
        <Match when={working()}>
          <div class="flex items-center gap-2.5 px-4 h-14">
            <Loader width={16} height={16} />
            <span class="text-[13px] text-v2-text-text-base truncate">{ctx.t("visual.saving")}</span>
            <span class="ms-auto font-mono text-[12px] tabular-nums text-v2-text-text-muted">{elapsed()}</span>
            <button type="button" class={quiet} onClick={() => visual.stopSave()}>
              <Icon name="stop" size="small" />
              {ctx.t("visual.stop")}
            </button>
          </div>
        </Match>
        <Match when={true}>
          <div class="flex flex-col gap-2 px-4 py-3">
            <Show when={visual.saving() === "error" && visual.saveError() !== undefined}>
              <p class="text-[12px] text-v2-state-fg-danger">{ctx.t("visual.saveFailed", { reason: visual.saveError() ?? "" })}</p>
            </Show>
            <Show when={visual.blockedReason() === "busy" && count() > 0}>
              <p class="text-[12px] text-v2-text-text-muted">{ctx.t("visual.busy")}</p>
            </Show>
            <div class="flex items-center gap-1">
              <button
                type="button"
                class="flex items-center gap-1 h-8 px-1.5 rounded-md text-[12px] text-v2-text-text-muted cursor-pointer hover:bg-v2-overlay-simple-overlay-hover disabled:cursor-default disabled:hover:bg-transparent"
                disabled={count() === 0}
                aria-expanded={open()}
                onClick={() => setOpen((value) => !value)}
              >
                <Show when={count() > 0} fallback={ctx.t("visual.changes.none")}>
                  <Icon name="chevron-right" size="small" class="transition-transform" classList={{ "-rotate-90": open() }} />
                  {ctx.plural("visual.changes", count())}
                </Show>
              </button>
              <Tooltip value={ctx.t("visual.undo")} placement="top">
                <button type="button" class={iconButton} aria-label={ctx.t("visual.undo")} disabled={visual.pending().done.length === 0} onClick={() => visual.undo()}>
                  <Icon name="outline-undo" size="small" />
                </button>
              </Tooltip>
              <Tooltip value={ctx.t("visual.redo")} placement="top">
                <button type="button" class={iconButton} aria-label={ctx.t("visual.redo")} disabled={visual.pending().undone.length === 0} onClick={() => visual.redo()}>
                  <Icon name="outline-undo" size="small" class="-scale-x-100" />
                </button>
              </Tooltip>
              <div class="ms-auto flex items-center gap-1.5">
                <button
                  type="button"
                  class={quiet}
                  classList={{ "text-v2-state-fg-danger": confirming() }}
                  disabled={count() === 0}
                  onBlur={() => setConfirming(false)}
                  onClick={() => {
                    if (count() > 3 && !confirming()) return setConfirming(true)
                    setConfirming(false)
                    visual.discard()
                  }}
                >
                  {confirming() ? ctx.plural("visual.discard.confirm", count()) : ctx.t("visual.discard")}
                </button>
                <button type="button" class={brand} disabled={!visual.canSave()} data-action="visual-save" onClick={() => void visual.save()}>
                  {ctx.t("visual.save")}
                </button>
              </div>
            </div>
          </div>
        </Match>
      </Switch>
    </div>
  )
}

const describe = (change: LiveChange) =>
  `<${change.fingerprint.tag}${change.fingerprint.id ? `#${change.fingerprint.id}` : ""}${change.fingerprint.classes.slice(0, 2).map((name) => `.${name}`).join("")}>`

function summary(change: LiveChange, t: (key: string) => string) {
  if (change.kind === "text") return `${t("visual.change.text")}: “${change.after}”`

  if (change.kind === "move") return `${t("visual.change.move")}: ${change.before} → ${change.after}`

  return `${change.property}: ${change.before || "—"} → ${change.after}`
}
