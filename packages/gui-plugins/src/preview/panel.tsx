import { createMemo, createSignal, For, Match, onCleanup, Show, Switch, type Accessor, type JSX } from "solid-js"
import { createKeyed, usePlugin } from "@opencode/plugin/gui"
import type { Preview } from "@opencode/schema/preview"
import { Button } from "@opencode/ui/button"
import { useDialog } from "@opencode/ui/context/dialog"
import { RecipeDialog } from "./recipe-dialog"
import { DEVICE_WIDTH, type PreviewView } from "./view"

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g

// The app icon with its background, as everywhere the logo shows.
const LOGO = "/web-app-manifest-192x192.png"

// Room around a tablet or mobile frame.
const FRAME_INSET = 24

// The copy under "Starting preview..." for each step.
const STEPS: Partial<
  Record<Preview.State, "state.detecting" | "state.installing" | "state.starting" | "state.fixing">
> = {
  detecting: "state.detecting",
  installing: "state.installing",
  starting: "state.starting",
  fixing: "state.fixing",
}

/** The Preview section's body: the running app in its device frame, or the step it is on, or why it failed. */
export default function PreviewPanel(props: { view: PreviewView; visible: Accessor<boolean> }) {
  const ctx = usePlugin()
  const dialog = useDialog()
  const view = props.view
  const [size, setSize] = createSignal({ width: 0, height: 0 })

  // An unwatched preview stops after a while; the panel marks it while it is on screen.
  createKeyed(
    () => (props.visible() ? true : undefined),
    () => onCleanup(view.watch()),
  )

  const measure = (element: HTMLDivElement) => {
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setSize({ width: entry.contentRect.width, height: entry.contentRect.height })
    })

    observer.observe(element)
    onCleanup(() => observer.disconnect())
  }

  // The zoom works like a browser's: the page lays out at the device width divided by the zoom, and the frame keeps its
  // size on screen, so a zoom never adds a scrollbar. Desktop fills the panel at 1440px wide at 100%; tablet and mobile
  // keep their own width, shrunk only when the panel is narrower.
  const frame = createMemo(() => {
    const desktop = view.state.device === "desktop"
    const device = DEVICE_WIDTH[view.state.device]
    const inset = desktop ? 0 : FRAME_INSET
    const available = Math.max(1, size().width - inset)
    const shown = desktop ? available : Math.min(device, available)
    const viewport = device / (view.state.zoom / 100)
    const scale = shown / viewport
    const height = Math.max(1, size().height - inset)

    return { shown, height, viewport, scale, desktop }
  })

  // The address whose first page has arrived in the frame. Reloads happen inside the frame and keep its address, so
  // the loader shows only for a fresh load. A page that never reports loading is shown after a while anyway.
  const [loaded, setLoaded] = createSignal<string>()
  const [gaveUp, setGaveUp] = createSignal(false)

  createKeyed(
    () => (view.running() && view.state.src !== loaded() ? view.state.src : undefined),
    () => {
      setGaveUp(false)
      const timer = setTimeout(() => setGaveUp(true), 20_000)

      onCleanup(() => clearTimeout(timer))
    },
  )

  const editRecipe = () =>
    dialog.show(() => <RecipeDialog recipe={view.state.status.recipe} onSave={(recipe) => view.setRecipe(recipe)} />)

  const plainLog = () => view.state.log.replace(ANSI, "")

  return (
    <div data-component="preview-panel" class="flex h-full min-h-0 flex-col bg-v2-background-bg-base">
      <div ref={measure} class="relative min-h-0 flex-1 overflow-hidden">
        <Switch>
          <Match when={view.running() && view.state.src}>
            {(src) => (
              <div class="flex h-full items-center justify-center">
                <div
                  class="relative overflow-hidden"
                  classList={{
                    "rounded-[10px] border border-v2-border-border-base shadow-[var(--v2-elevation-raised)]":
                      !frame().desktop,
                  }}
                  style={{ width: `${frame().shown}px`, height: `${frame().height}px` }}
                >
                  <iframe
                    ref={(element) => view.setFrame(element)}
                    title={ctx.t("tab.title")}
                    src={src()}
                    class="block origin-top-left border-0 bg-[#fff]"
                    style={{
                      width: `${frame().viewport}px`,
                      height: `${frame().height / frame().scale}px`,
                      transform: `scale(${frame().scale})`,
                    }}
                    allow="clipboard-read; clipboard-write; fullscreen"
                    onLoad={() => {
                      setLoaded(src())
                      view.frameLoaded()
                    }}
                  />
                  {/* Until the app's first page arrives the frame is blank white, and a page that isn't the preview's
                      (an error page after a pause or a dropped connection) is never shown: the brand loader covers both. */}
                  <Show when={(loaded() !== src() && !gaveUp()) || view.state.covered}>
                    <div class="absolute inset-0 flex items-center justify-center bg-v2-background-bg-base">
                      <div
                        data-component="brand-loader"
                        role="status"
                        aria-live="polite"
                        aria-label={ctx.t("frame.loading")}
                        class="flex items-center justify-center"
                      >
                        <span class="relative flex size-14 items-center justify-center">
                          <span
                            data-slot="brand-loader-halo"
                            class="absolute inset-0 rounded-[14px] bg-[#0a3a78]/30"
                            aria-hidden="true"
                          />
                          <span data-slot="brand-loader-icon" class="relative">
                            <img
                              src={LOGO}
                              alt=""
                              draggable={false}
                              class="size-14 rounded-[14px] shadow-[0_8px_24px_rgb(10_58_120/0.25)]"
                            />
                          </span>
                        </span>
                      </div>
                    </div>
                  </Show>
                </div>
              </div>
            )}
          </Match>
          {/* Running, but the preview didn't answer: the brand icon, as for a project with nothing to show. */}
          <Match when={view.running() && view.state.unreachable}>
            <Centered>
              <img src={LOGO} alt="" draggable={false} class="size-14 rounded-[12px]" />
            </Centered>
          </Match>
          {/* Running, while the window waits for the preview to answer before loading the frame. */}
          <Match when={view.running()}>
            <Centered>
              <img src={LOGO} alt="" draggable={false} class="size-16 rounded-[14px] opacity-30 animate-pulse" />
            </Centered>
          </Match>
          <Match when={view.busy()}>
            <Centered>
              <img src={LOGO} alt="" draggable={false} class="size-16 rounded-[14px] opacity-30 animate-pulse" />
              <div class="text-12-regular text-v2-text-text-muted">{ctx.t("starting")}</div>
              <div class="text-[11px] text-v2-text-text-faint">
                {ctx.t(STEPS[view.state.status.state] ?? "state.starting")}
                <Show when={view.state.status.fixing}>
                  {(fixing) => <> · {ctx.t("state.fixing.tries", { tries: String(fixing().tries) })}</>}
                </Show>
              </div>
              <Show when={view.state.status.state === "fixing"}>
                <Button size="small" variant="outline" onClick={() => view.stop()}>
                  {ctx.t("stop")}
                </Button>
              </Show>
            </Centered>
          </Match>
          <Match when={view.state.status.state === "choosing"}>
            <Centered>
              <img src={LOGO} alt="" draggable={false} class="size-12 rounded-[11px]" />
              <div class="text-14-medium text-v2-text-text-base">{ctx.t("state.choosing")}</div>
              <div class="flex w-full max-w-[360px] flex-col gap-1">
                <For each={view.state.status.candidates ?? []}>
                  {(candidate, index) => (
                    <button
                      type="button"
                      class="flex items-center justify-between gap-3 rounded-[6px] px-3 py-2 text-start text-[13px] text-v2-text-text-base hover:bg-v2-overlay-simple-overlay-hover"
                      onClick={() => view.start({ candidate: index() })}
                    >
                      <span class="truncate font-mono">
                        {candidate.recipe.root === "." ? ctx.t("candidate.root") : candidate.recipe.root}
                      </span>
                      <span class="shrink-0 text-12-regular text-v2-text-text-muted">{candidate.framework}</span>
                    </button>
                  )}
                </For>
              </div>
            </Centered>
          </Match>
          <Match when={view.state.status.state === "failed"}>
            <Centered>
              <img src={LOGO} alt="" draggable={false} class="size-16 rounded-[14px]" />
              <div class="text-14-medium text-v2-text-text-base">{ctx.t("state.failed")}</div>
              <Show when={view.state.status.reason}>
                {(reason) => (
                  <div class="max-w-[420px] text-center text-[13px] text-v2-text-text-muted">{reason()}</div>
                )}
              </Show>
              <div class="flex gap-2">
                <Button size="small" variant="contrast" onClick={() => view.start({ retry: true })}>
                  {ctx.t("try.again")}
                </Button>
                <Button size="small" variant="outline" onClick={editRecipe}>
                  {ctx.t("edit.command")}
                </Button>
              </div>
              <LogTail text={plainLog()} />
            </Centered>
          </Match>
          <Match when={view.state.status.state === "stopped"}>
            <Centered>
              <img src={LOGO} alt="" draggable={false} class="size-16 rounded-[14px] opacity-60" />
              <div class="text-[13px] text-v2-text-text-muted">{ctx.t("state.stopped")}</div>
              <Button size="small" variant="contrast" onClick={() => view.start({ retry: true })}>
                {ctx.t("start")}
              </Button>
            </Centered>
          </Match>
          <Match when={true}>
            <Centered>
              <img src={LOGO} alt="" draggable={false} class="size-14 rounded-[12px]" />
            </Centered>
          </Match>
        </Switch>
      </div>

      <Show when={view.state.logs}>
        <div class="flex h-[40%] min-h-[120px] shrink-0 flex-col border-t border-v2-border-border-muted">
          <div class="flex h-8 shrink-0 items-center justify-between px-3 text-12-medium text-v2-text-text-muted">
            {ctx.t("logs.title")}
            <button
              type="button"
              class="rounded px-1.5 text-12-regular hover:bg-v2-overlay-simple-overlay-hover"
              onClick={() => view.toggleLogs()}
            >
              {ctx.t("logs.hide")}
            </button>
          </div>
          <pre class="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-all px-3 pb-2 font-mono text-[11px] text-v2-text-text-base">
            {plainLog() || ctx.t("logs.empty")}
          </pre>
        </div>
      </Show>
    </div>
  )
}

function Centered(props: { children: JSX.Element }) {
  return (
    <div class="absolute inset-0 flex flex-col items-center justify-center gap-3 overflow-hidden p-6 text-center">
      {props.children}
    </div>
  )
}

// The last lines of the log under a failure.
function LogTail(props: { text: string }) {
  const tail = () => props.text.split("\n").slice(-12).join("\n").trim()

  return (
    <Show when={tail()}>
      <pre class="max-h-[40%] w-full max-w-[560px] overflow-auto whitespace-pre-wrap break-all rounded-[6px] bg-v2-background-bg-layer-02 p-3 text-start font-mono text-[11px] text-v2-text-text-muted">
        {tail()}
      </pre>
    </Show>
  )
}
