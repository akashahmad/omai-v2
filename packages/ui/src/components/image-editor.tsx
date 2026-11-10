import { createResizeObserver } from "@solid-primitives/resize-observer"
import { createSignal, For, Match, onMount, Show, Switch, type JSX } from "solid-js"
import { useI18n } from "../context/i18n"

export type ImageEditorMode = "draw" | "crop" | "rotate"

type Tool = "pen" | "box" | "arrow"

type Rect = { x: number; y: number; w: number; h: number }

type Point = { x: number; y: number }

type Handle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w"

const COLORS = ["#ef4444", "#f97316", "#eab308", "#22c55e", "#1a64d6", "#a855f7", "#000000", "#ffffff"]

const ASPECTS = [
  { id: "free", ratio: undefined },
  { id: "1:1", ratio: 1 },
  { id: "4:3", ratio: 4 / 3 },
  { id: "16:9", ratio: 16 / 9 },
  { id: "9:16", ratio: 9 / 16 },
] as const

const HANDLES: Handle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"]

const HISTORY = 25

const MIN_CROP = 8

/**
 * Draws on, crops and rotates an image, then hands the result back as a PNG file. Every change lands on one canvas, so
 * the tools combine in any order and each step can be undone.
 */
export function ImageEditor(props: {
  src: string
  name?: string
  mode: ImageEditorMode
  onCancel: () => void
  onDone: (file: File) => void
}) {
  const i18n = useI18n()
  let board!: HTMLCanvasElement
  let stage!: HTMLDivElement
  const [mode, setMode] = createSignal<ImageEditorMode>(props.mode)
  const [state, setState] = createSignal<"loading" | "ready" | "failed">("loading")
  const [size, setSize] = createSignal({ width: 1, height: 1 })
  const [room, setRoom] = createSignal({ width: 1, height: 1 })
  const [tool, setTool] = createSignal<Tool>("pen")
  const [color, setColor] = createSignal(COLORS[0]!)
  const [brush, setBrush] = createSignal(4)
  const [aspect, setAspect] = createSignal<(typeof ASPECTS)[number]>(ASPECTS[0])
  const [crop, setCrop] = createSignal<Rect>()
  const [history, setHistory] = createSignal<ImageData[]>([])
  const [saving, setSaving] = createSignal(false)
  let original: ImageData | undefined

  const context = () => board.getContext("2d", { willReadFrequently: true })!

  // The canvas fits the stage; small images grow up to twice their size so there is room to draw.
  const scale = () => Math.min(room().width / size().width, room().height / size().height, 2)
  const shown = () => ({ width: size().width * scale(), height: size().height * scale() })

  const snapshot = () => context().getImageData(0, 0, board.width, board.height)

  const restore = (data: ImageData) => {
    board.width = data.width
    board.height = data.height
    context().putImageData(data, 0, 0)
    setSize({ width: data.width, height: data.height })
  }

  const remember = () => setHistory((list) => [...list.slice(1 - HISTORY), snapshot()])

  const undo = () => {
    const list = history()
    const last = list.at(-1)

    if (!last) return
    restore(last)
    setHistory(list.slice(0, -1))
    setCrop(undefined)
  }

  const reset = () => {
    if (!original) return
    remember()
    restore(original)
    setCrop(undefined)
  }

  onMount(() => {
    createResizeObserver(stage, ({ width, height }) =>
      setRoom({ width: Math.max(1, width - 48), height: Math.max(1, height - 48) }),
    )

    void loadImage(props.src).then(
      (image) => {
        board.width = image.width
        board.height = image.height
        context().drawImage(image, 0, 0)
        original = snapshot()
        setSize({ width: image.width, height: image.height })
        setState("ready")
      },
      () => setState("failed"),
    )
  })

  // Pointer position on the canvas, in its own pixels.
  const point = (event: PointerEvent): Point => {
    const box = board.getBoundingClientRect()

    return {
      x: clamp(((event.clientX - box.left) / box.width) * board.width, 0, board.width),
      y: clamp(((event.clientY - box.top) / box.height) * board.height, 0, board.height),
    }
  }

  // Drawing: a pen stroke paints as it goes; a box or an arrow redraws over the picture as it was when the drag began.
  let stroke: { from: Point; last: Point; before: ImageData } | undefined

  const paint = (draw: (ctx: CanvasRenderingContext2D) => void) => {
    const ctx = context()
    ctx.save()
    ctx.strokeStyle = color()
    ctx.fillStyle = color()
    ctx.lineWidth = brush() / scale()
    ctx.lineCap = "round"
    ctx.lineJoin = "round"
    draw(ctx)
    ctx.restore()
  }

  const drawStart = (event: PointerEvent) => {
    if (event.button !== 0) return
    event.preventDefault()
    board.setPointerCapture(event.pointerId)
    remember()
    const at = point(event)
    stroke = { from: at, last: at, before: snapshot() }

    if (tool() === "pen")
      paint((ctx) => {
        ctx.beginPath()
        ctx.arc(at.x, at.y, ctx.lineWidth / 2, 0, Math.PI * 2)
        ctx.fill()
      })
  }

  const drawMove = (event: PointerEvent) => {
    if (!stroke) return
    const at = point(event)
    const from = stroke.from
    const last = stroke.last

    if (tool() === "pen") {
      paint((ctx) => {
        ctx.beginPath()
        ctx.moveTo(last.x, last.y)
        ctx.lineTo(at.x, at.y)
        ctx.stroke()
      })
      stroke.last = at

      return
    }

    context().putImageData(stroke.before, 0, 0)
    paint((ctx) => (tool() === "box" ? box(ctx, from, at) : arrow(ctx, from, at)))
  }

  const drawEnd = (event: PointerEvent) => {
    if (!stroke) return
    stroke = undefined

    if (board.hasPointerCapture(event.pointerId)) board.releasePointerCapture(event.pointerId)
  }

  // Cropping: drag on the picture for a new frame, drag inside it to move it, or drag a handle to resize it.
  let gesture: { kind: "new" | "move" | Handle; start: Point; rect: Rect } | undefined

  const bounds = () => ({ width: board.width, height: board.height })

  const cropStart = (event: PointerEvent, kind: "new" | "move" | Handle) => {
    if (event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    stage.setPointerCapture(event.pointerId)
    const start = point(event)
    gesture = { kind, start, rect: crop() ?? { x: start.x, y: start.y, w: 0, h: 0 } }
  }

  const cropMove = (event: PointerEvent) => {
    if (!gesture) return
    const at = point(event)
    const rect = gesture.rect
    const area = bounds()

    if (gesture.kind === "move") {
      setCrop({
        ...rect,
        x: clamp(rect.x + at.x - gesture.start.x, 0, area.width - rect.w),
        y: clamp(rect.y + at.y - gesture.start.y, 0, area.height - rect.h),
      })

      return
    }

    if (gesture.kind === "new") return setCrop(frameFrom(gesture.start, at, aspect().ratio, area))

    const anchor = anchorOf(gesture.kind, rect)

    if (anchor) return setCrop(frameFrom(anchor, at, aspect().ratio, area))

    setCrop(edge(gesture.kind, rect, at))
  }

  const cropEnd = (event: PointerEvent) => {
    if (!gesture) return
    gesture = undefined

    if (stage.hasPointerCapture(event.pointerId)) stage.releasePointerCapture(event.pointerId)
    const rect = crop()

    if (rect && (rect.w < MIN_CROP || rect.h < MIN_CROP)) setCrop(undefined)
  }

  const chooseAspect = (next: (typeof ASPECTS)[number]) => {
    setAspect(next)
    const ratio = next.ratio

    if (!ratio) return
    // A fixed ratio starts as the largest centred frame of that shape.
    const area = bounds()
    const w = Math.min(area.width, area.height * ratio)
    const h = w / ratio
    setCrop({ x: (area.width - w) / 2, y: (area.height - h) / 2, w, h })
  }

  const applyCrop = () => {
    const rect = crop()

    if (!rect) return
    remember()
    const x = Math.round(rect.x)
    const y = Math.round(rect.y)
    const w = Math.max(1, Math.round(rect.w))
    const h = Math.max(1, Math.round(rect.h))
    restore(context().getImageData(x, y, w, h))
    setCrop(undefined)
    setAspect(ASPECTS[0])
  }

  // Rotating and flipping redraw the picture onto a canvas of its new shape.
  const transform = (turn: -1 | 0 | 1, flip?: "x" | "y") => {
    remember()
    const copy = document.createElement("canvas")
    copy.width = board.width
    copy.height = board.height
    copy.getContext("2d")!.putImageData(snapshot(), 0, 0)
    const width = turn === 0 ? copy.width : copy.height
    const height = turn === 0 ? copy.height : copy.width
    board.width = width
    board.height = height
    const ctx = context()
    ctx.save()
    ctx.translate(width / 2, height / 2)
    ctx.rotate((turn * Math.PI) / 2)

    if (flip) ctx.scale(flip === "x" ? -1 : 1, flip === "y" ? -1 : 1)
    ctx.drawImage(copy, -copy.width / 2, -copy.height / 2)
    ctx.restore()
    setSize({ width, height })
    setCrop(undefined)
  }

  const finish = () => {
    if (saving()) return
    setSaving(true)
    board.toBlob((blob) => {
      setSaving(false)

      if (!blob) return
      props.onDone(new File([blob], editedName(props.name), { type: "image/png" }))
    }, "image/png")
  }

  const switchMode = (next: ImageEditorMode) => {
    setMode(next)
    setCrop(undefined)
  }

  const cropStyle = (rect: Rect) => ({
    left: `${rect.x * scale()}px`,
    top: `${rect.y * scale()}px`,
    width: `${rect.w * scale()}px`,
    height: `${rect.h * scale()}px`,
  })

  return (
    <div
      data-component="image-editor"
      class="absolute inset-0 z-[60] flex flex-col bg-v2-background-bg-base text-v2-text-text-base"
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
          event.preventDefault()
          undo()
        }

        if (event.key === "Enter" && mode() === "crop" && crop()) {
          event.preventDefault()
          applyCrop()
        }
      }}
    >
      <header class="flex h-14 shrink-0 items-center gap-3 border-b border-v2-border-border-base px-4">
        <div class="text-[14px] font-[600] text-v2-text-text-base">{i18n.t("ui.imageEditor.title")}</div>
        <div class="mx-auto flex items-center gap-0.5 rounded-[8px] bg-v2-background-bg-layer-02 p-0.5">
          <For each={["draw", "crop", "rotate"] as const}>
            {(item) => (
              <button
                type="button"
                class="flex h-8 cursor-pointer items-center gap-1.5 rounded-[6px] px-3 text-[13px] font-[500] transition-colors"
                classList={{
                  "bg-v2-background-bg-base text-v2-text-text-base shadow-[var(--v2-elevation-raised)]":
                    mode() === item,
                  "text-v2-text-text-muted hover:text-v2-text-text-base": mode() !== item,
                }}
                disabled={state() !== "ready"}
                onClick={() => switchMode(item)}
              >
                <ModeIcon mode={item} />
                {i18n.t(`ui.imageEditor.${item}`)}
              </button>
            )}
          </For>
        </div>
        <div class="flex items-center gap-1">
          <ToolbarButton label={i18n.t("ui.imageEditor.undo")} disabled={history().length === 0} onClick={undo}>
            <svg viewBox="0 0 16 16" fill="none" class="size-4">
              <path d="M6 4L3 7l3 3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
              <path d="M3.5 7H10a3 3 0 010 6H8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
            </svg>
          </ToolbarButton>
          <ToolbarButton label={i18n.t("ui.imageEditor.reset")} disabled={history().length === 0} onClick={reset}>
            <svg viewBox="0 0 16 16" fill="none" class="size-4">
              <path d="M3 8a5 5 0 105-5 5.4 5.4 0 00-3.7 1.5L3 6" stroke="currentColor" stroke-width="1.5" />
              <path d="M3 3v3h3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
            </svg>
          </ToolbarButton>
        </div>
      </header>

      <div
        ref={stage}
        class="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-v2-background-bg-layer-01 select-none"
        style={{
          "background-image":
            "radial-gradient(circle, color-mix(in srgb, var(--v2-text-text-faint) 35%, transparent) 0.8px, transparent 0.8px)",
          "background-size": "22px 22px",
        }}
        onPointerMove={cropMove}
        onPointerUp={cropEnd}
        onPointerCancel={cropEnd}
      >
        <Show when={state() !== "ready"}>
          <div class="absolute inset-0 flex items-center justify-center text-[13px] text-v2-text-text-muted">
            {state() === "failed" ? i18n.t("ui.imageEditor.failed") : i18n.t("ui.imageEditor.loading")}
          </div>
        </Show>
        <div
          class="relative shadow-[0_8px_30px_rgba(0,0,0,0.18)]"
          classList={{ invisible: state() !== "ready" }}
          style={{ width: `${shown().width}px`, height: `${shown().height}px` }}
        >
          <canvas
            ref={board}
            class="block size-full"
            style={{
              cursor: mode() === "draw" ? "crosshair" : "default",
              "touch-action": "none",
              "background-image": "conic-gradient(#e5e7eb 25%, #fff 0 50%, #e5e7eb 0 75%, #fff 0) 0 0 / 16px 16px",
            }}
            onPointerDown={(event) => (mode() === "draw" ? drawStart(event) : undefined)}
            onPointerMove={drawMove}
            onPointerUp={drawEnd}
            onPointerCancel={drawEnd}
          />
          <Show when={mode() === "crop"}>
            <div
              class="absolute inset-0 cursor-crosshair"
              style={{ "touch-action": "none" }}
              onPointerDown={(event) => cropStart(event, "new")}
            >
              <Show when={crop()}>
                {(rect) => (
                  <div
                    class="absolute cursor-move outline outline-2 outline-[#fff]"
                    style={{ ...cropStyle(rect()), "box-shadow": "0 0 0 9999px rgba(0, 0, 0, 0.55)" }}
                    onPointerDown={(event) => cropStart(event, "move")}
                  >
                    <div class="pointer-events-none absolute inset-0 grid grid-cols-3 grid-rows-3">
                      <For each={Array.from({ length: 9 })}>{() => <div class="border border-[#fff]/25" />}</For>
                    </div>
                    <For each={aspect().ratio ? HANDLES.filter((handle) => handle.length === 2) : HANDLES}>
                      {(handle) => (
                        <div
                          class="absolute size-3.5 rounded-[3px] border-2 border-[#1a64d6] bg-[#fff]"
                          style={{ ...handleStyle(handle), cursor: `${handle}-resize` }}
                          onPointerDown={(event) => cropStart(event, handle)}
                        />
                      )}
                    </For>
                  </div>
                )}
              </Show>
            </div>
          </Show>
        </div>
      </div>

      <footer class="flex min-h-16 shrink-0 flex-wrap items-center gap-3 border-t border-v2-border-border-base px-4 py-3">
        <div class="flex min-w-0 flex-1 flex-wrap items-center gap-3">
          <Switch>
            <Match when={mode() === "draw"}>
              <Segment>
                <For each={["pen", "box", "arrow"] as const}>
                  {(item) => (
                    <SegmentButton active={tool() === item} onClick={() => setTool(item)}>
                      {i18n.t(`ui.imageEditor.${item}`)}
                    </SegmentButton>
                  )}
                </For>
              </Segment>
              <div class="flex items-center gap-1.5">
                <For each={COLORS}>
                  {(item) => (
                    <button
                      type="button"
                      class="size-6 cursor-pointer rounded-full border border-[#000]/15 transition-transform hover:scale-110"
                      classList={{
                        "ring-2 ring-[#1a64d6] ring-offset-2 ring-offset-v2-background-bg-base": color() === item,
                      }}
                      style={{ "background-color": item }}
                      aria-label={i18n.t("ui.imageEditor.color", { color: item })}
                      onClick={() => setColor(item)}
                    />
                  )}
                </For>
              </div>
              <label class="flex items-center gap-2 text-[12px] text-v2-text-text-muted">
                <span
                  class="inline-block shrink-0 rounded-full"
                  style={{ width: `${brush()}px`, height: `${brush()}px`, "background-color": color() }}
                />
                <input
                  type="range"
                  min="1"
                  max="24"
                  value={brush()}
                  class="w-28 cursor-pointer accent-[#1a64d6]"
                  aria-label={i18n.t("ui.imageEditor.size")}
                  onInput={(event) => setBrush(Number(event.currentTarget.value))}
                />
              </label>
            </Match>
            <Match when={mode() === "crop"}>
              <Segment>
                <For each={ASPECTS}>
                  {(item) => (
                    <SegmentButton active={aspect().id === item.id} onClick={() => chooseAspect(item)}>
                      {item.ratio ? item.id : i18n.t("ui.imageEditor.aspect.free")}
                    </SegmentButton>
                  )}
                </For>
              </Segment>
              <button
                type="button"
                class="h-8 cursor-pointer rounded-[6px] border border-v2-border-border-base px-3 text-[13px] font-[500] text-v2-text-text-base hover:bg-v2-overlay-simple-overlay-hover disabled:cursor-not-allowed disabled:opacity-40"
                disabled={!crop()}
                onClick={applyCrop}
              >
                {i18n.t("ui.imageEditor.applyCrop")}
              </button>
            </Match>
            <Match when={mode() === "rotate"}>
              <div class="flex items-center gap-1">
                <ToolbarButton label={i18n.t("ui.imageEditor.rotateLeft")} onClick={() => transform(-1)} text>
                  <svg viewBox="0 0 16 16" fill="none" class="size-4">
                    <path d="M3 8a5 5 0 105-5H5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
                    <path d="M7 1L5 3l2 2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
                  </svg>
                </ToolbarButton>
                <ToolbarButton label={i18n.t("ui.imageEditor.rotateRight")} onClick={() => transform(1)} text>
                  <svg viewBox="0 0 16 16" fill="none" class="size-4">
                    <path d="M13 8a5 5 0 11-5-5h3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
                    <path d="M9 1l2 2-2 2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
                  </svg>
                </ToolbarButton>
                <ToolbarButton label={i18n.t("ui.imageEditor.flipHorizontal")} onClick={() => transform(0, "x")} text>
                  <svg viewBox="0 0 16 16" fill="none" class="size-4">
                    <path d="M8 1.5v13" stroke="currentColor" stroke-width="1.2" stroke-dasharray="2 2" />
                    <path d="M6 4L2 12h4V4zM10 4l4 8h-4V4z" stroke="currentColor" stroke-width="1.3" />
                  </svg>
                </ToolbarButton>
                <ToolbarButton label={i18n.t("ui.imageEditor.flipVertical")} onClick={() => transform(0, "y")} text>
                  <svg viewBox="0 0 16 16" fill="none" class="size-4">
                    <path d="M1.5 8h13" stroke="currentColor" stroke-width="1.2" stroke-dasharray="2 2" />
                    <path d="M4 6l8-4v4H4zM4 10l8 4v-4H4z" stroke="currentColor" stroke-width="1.3" />
                  </svg>
                </ToolbarButton>
              </div>
            </Match>
          </Switch>
        </div>
        <div class="flex items-center gap-2">
          <button
            type="button"
            class="h-9 cursor-pointer rounded-[6px] px-3.5 text-[13px] font-[500] text-v2-text-text-base hover:bg-v2-overlay-simple-overlay-hover"
            onClick={() => props.onCancel()}
          >
            {i18n.t("ui.common.cancel")}
          </button>
          <button
            type="button"
            class="flex h-9 cursor-pointer items-center gap-2 rounded-[6px] bg-[#0a3a78] px-4 text-[13px] font-[600] text-[#fff] hover:bg-[#082f62] disabled:cursor-not-allowed disabled:opacity-50"
            disabled={state() !== "ready" || saving()}
            onClick={finish}
          >
            <svg viewBox="0 0 16 16" fill="none" class="size-4">
              <path
                d="M13.5 7.5l-5.2 5.2a3.3 3.3 0 01-4.7-4.7l5.6-5.6a2.2 2.2 0 013.1 3.1L6.8 11a1.1 1.1 0 01-1.6-1.6l4.9-4.9"
                stroke="currentColor"
                stroke-width="1.4"
                stroke-linecap="round"
              />
            </svg>
            {i18n.t("ui.imageEditor.attach")}
          </button>
        </div>
      </footer>
    </div>
  )
}

function ModeIcon(props: { mode: ImageEditorMode }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" class="size-3.5">
      <Switch>
        <Match when={props.mode === "draw"}>
          <path d="M11 1.5L14.5 5 6 13.5H2.5V10L11 1.5z" stroke="currentColor" stroke-width="1.4" />
        </Match>
        <Match when={props.mode === "crop"}>
          <path d="M4 1v11h11M1 4h11v11" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
        </Match>
        <Match when={props.mode === "rotate"}>
          <path d="M2 8a6 6 0 106-6 6.4 6.4 0 00-4.4 1.8L2 5.5" stroke="currentColor" stroke-width="1.4" />
          <path d="M2 2v3.5h3.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
        </Match>
      </Switch>
    </svg>
  )
}

function ToolbarButton(props: {
  label: string
  disabled?: boolean
  text?: boolean
  onClick: () => void
  children: JSX.Element
}) {
  return (
    <button
      type="button"
      title={props.label}
      aria-label={props.label}
      class="flex h-8 cursor-pointer items-center gap-1.5 rounded-[6px] px-2 text-[13px] text-v2-text-text-base hover:bg-v2-overlay-simple-overlay-hover disabled:cursor-not-allowed disabled:opacity-35 disabled:hover:bg-transparent"
      disabled={props.disabled}
      onClick={() => props.onClick()}
    >
      {props.children}
      <Show when={props.text}>
        <span>{props.label}</span>
      </Show>
    </button>
  )
}

function Segment(props: { children: JSX.Element }) {
  return <div class="flex items-center gap-0.5 rounded-[8px] bg-v2-background-bg-layer-02 p-0.5">{props.children}</div>
}

function SegmentButton(props: { active: boolean; onClick: () => void; children: JSX.Element }) {
  return (
    <button
      type="button"
      class="h-7 cursor-pointer rounded-[6px] px-2.5 text-[12px] font-[500] transition-colors"
      classList={{
        "bg-v2-background-bg-base text-v2-text-text-base shadow-[var(--v2-elevation-raised)]": props.active,
        "text-v2-text-text-muted hover:text-v2-text-text-base": !props.active,
      }}
      onClick={() => props.onClick()}
    >
      {props.children}
    </button>
  )
}

/** Loads an image's pixels. Fetching first keeps a remote image from tainting the canvas the editor exports. */
export async function loadImage(src: string) {
  const response = await fetch(src, { credentials: "include" })

  if (!response.ok) throw new Error(`Image request failed: ${response.status}`)

  return createImageBitmap(await response.blob())
}

/** The image as PNG bytes, for copying to the clipboard, which only takes PNG images. */
export async function pngBlob(src: string) {
  const image = await loadImage(src)
  const canvas = document.createElement("canvas")
  canvas.width = image.width
  canvas.height = image.height
  canvas.getContext("2d")!.drawImage(image, 0, 0)

  return new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("Image export failed"))), "image/png"),
  )
}

function editedName(name: string | undefined) {
  const base = (name ?? "image").replace(/\.[^.]+$/, "").trim() || "image"

  return `${base}-edited.png`
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

function box(ctx: CanvasRenderingContext2D, from: Point, to: Point) {
  ctx.strokeRect(from.x, from.y, to.x - from.x, to.y - from.y)
}

function arrow(ctx: CanvasRenderingContext2D, from: Point, to: Point) {
  const angle = Math.atan2(to.y - from.y, to.x - from.x)
  const head = Math.max(10, ctx.lineWidth * 4)
  ctx.beginPath()
  ctx.moveTo(from.x, from.y)
  ctx.lineTo(to.x, to.y)
  ctx.stroke()
  ctx.beginPath()
  ctx.moveTo(to.x, to.y)
  ctx.lineTo(to.x - head * Math.cos(angle - Math.PI / 6), to.y - head * Math.sin(angle - Math.PI / 6))
  ctx.lineTo(to.x - head * Math.cos(angle + Math.PI / 6), to.y - head * Math.sin(angle + Math.PI / 6))
  ctx.closePath()
  ctx.fill()
}

// The frame between a fixed corner and the pointer, kept to `ratio` and inside the picture.
function frameFrom(anchor: Point, at: Point, ratio: number | undefined, area: { width: number; height: number }): Rect {
  const right = at.x >= anchor.x
  const down = at.y >= anchor.y
  const room = { w: right ? area.width - anchor.x : anchor.x, h: down ? area.height - anchor.y : anchor.y }
  const raw = { w: Math.abs(at.x - anchor.x), h: Math.abs(at.y - anchor.y) }

  if (!ratio) {
    const width = Math.min(raw.w, room.w)
    const height = Math.min(raw.h, room.h)

    return { x: right ? anchor.x : anchor.x - width, y: down ? anchor.y : anchor.y - height, w: width, h: height }
  }

  // The larger side of the drag leads; the frame then shrinks, keeping its shape, until it fits the picture.
  const fitted = raw.w > raw.h * ratio ? { w: raw.w, h: raw.w / ratio } : { w: raw.h * ratio, h: raw.h }
  const shrink = Math.min(1, room.w / Math.max(fitted.w, 1e-6), room.h / Math.max(fitted.h, 1e-6))
  const width = fitted.w * shrink
  const height = fitted.h * shrink

  return { x: right ? anchor.x : anchor.x - width, y: down ? anchor.y : anchor.y - height, w: width, h: height }
}

// The corner opposite a corner handle, which stays put while that handle is dragged.
function anchorOf(handle: Handle, rect: Rect): Point | undefined {
  if (handle === "nw") return { x: rect.x + rect.w, y: rect.y + rect.h }

  if (handle === "ne") return { x: rect.x, y: rect.y + rect.h }

  if (handle === "sw") return { x: rect.x + rect.w, y: rect.y }

  if (handle === "se") return { x: rect.x, y: rect.y }
}

// One side of the frame follows the pointer; the opposite side stays.
function edge(handle: Handle, rect: Rect, at: Point): Rect {
  if (handle === "n") {
    const y = Math.min(at.y, rect.y + rect.h - MIN_CROP)

    return { ...rect, y, h: rect.y + rect.h - y }
  }

  if (handle === "s") return { ...rect, h: Math.max(MIN_CROP, at.y - rect.y) }

  if (handle === "w") {
    const x = Math.min(at.x, rect.x + rect.w - MIN_CROP)

    return { ...rect, x, w: rect.x + rect.w - x }
  }

  return { ...rect, w: Math.max(MIN_CROP, at.x - rect.x) }
}

function handleStyle(handle: Handle): JSX.CSSProperties {
  const x = handle.includes("w") ? "0%" : handle.includes("e") ? "100%" : "50%"
  const y = handle.includes("n") ? "0%" : handle.includes("s") ? "100%" : "50%"

  return { left: x, top: y, transform: "translate(-50%, -50%)" }
}
