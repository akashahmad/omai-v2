import { createMemo, createSignal, For, Match, onCleanup, Show, Switch } from "solid-js"
import { usePlugin } from "@opencode/plugin/gui"
import { useDialog } from "@opencode/ui/context/dialog"
import { Icon } from "@opencode/ui/icon"
import { IconButton } from "@opencode/ui/icon-button"
import { Menu } from "@opencode/ui/menu"
import { Tooltip } from "@opencode/ui/tooltip"
import { PublishDialog } from "./publish-dialog"
import { ZOOM_OPTIONS, type Device, type PreviewView } from "./view"

const NEXT_DEVICE: Record<Device, Device> = { desktop: "tablet", tablet: "mobile", mobile: "desktop" }

// Below this width the zoom and open-in-browser controls move into the options menu.
const COMPACT_WIDTH = 380

/** The preview's controls in the right panel's toolbar: device, address, open in browser, zoom, options, Publish. */
export function PreviewToolbar(props: { view: PreviewView }) {
  const ctx = usePlugin()
  const dialog = useDialog()
  const view = props.view
  const [width, setWidth] = createSignal(Number.POSITIVE_INFINITY)
  const [search, setSearch] = createSignal("")
  const compact = () => width() < COMPACT_WIDTH
  let searchInput: HTMLInputElement | undefined

  const measure = (element: HTMLDivElement) => {
    const observer = new ResizeObserver(([entry]) => entry && setWidth(entry.contentRect.width))
    observer.observe(element)
    onCleanup(() => observer.disconnect())
  }

  const label = () => (view.state.path === "/" ? ctx.t("address.homepage") : view.state.path)

  // Every page the app links to plus the one on screen, filtered by the search.
  const pages = createMemo(() => {
    const query = search().trim().toLowerCase()
    const all = [...new Set(["/", ...view.state.pages, view.state.path.split(/[?#]/)[0] ?? "/"])].sort()

    return query ? all.filter((page) => page.toLowerCase().includes(query)) : all
  })

  // A typed path that isn't in the list yet, offered as "Go to".
  const typed = () => {
    const value = search().trim()

    if (!value) return undefined
    const path = value.startsWith("/") ? value : `/${value}`

    return pages().includes(path) ? undefined : path
  }

  const deviceLabel = () => ctx.t(`device.${view.state.device}`)

  return (
    <div ref={measure} data-component="preview-toolbar" class="flex flex-1 min-w-0 items-center gap-2">
      <div class="flex flex-1 min-w-0 items-center justify-center gap-1.5">
        <Tooltip
          value={
            !view.running()
              ? ctx.t("visual.toggle.unavailable")
              : view.visual.enabled()
                ? ctx.t("visual.toggle.off")
                : ctx.t("visual.toggle.on")
          }
          placement="bottom"
        >
          <button
            type="button"
            data-action="preview-visual"
            aria-pressed={view.visual.enabled()}
            aria-label={view.visual.enabled() ? ctx.t("visual.toggle.off") : ctx.t("visual.toggle.on")}
            disabled={!view.running()}
            class="flex shrink-0 items-center justify-center h-8 w-8 rounded-md cursor-pointer transition-colors disabled:opacity-40 disabled:cursor-default"
            classList={{
              // The same tint as the panel pill's active section.
              "bg-[#1a64d6]/15 shadow-[inset_0_0_0_1px_rgb(26_100_214/0.35)] text-[color-mix(in_srgb,#1a64d6_80%,var(--v2-text-text-base))]":
                view.visual.enabled(),
              "text-v2-text-text-muted hover:bg-v2-overlay-simple-overlay-hover hover:text-v2-text-text-base": !view.visual.enabled(),
            }}
            onClick={() => view.visual.toggle()}
          >
            <Icon name="select-element" size="small" />
          </button>
        </Tooltip>
        <Tooltip value={deviceLabel()} placement="bottom">
          <button
            type="button"
            data-action="preview-device"
            class="flex shrink-0 items-center justify-center h-8 w-8 rounded-md cursor-pointer transition-colors hover:bg-v2-overlay-simple-overlay-hover"
            onClick={() => view.setDevice(NEXT_DEVICE[view.state.device])}
            aria-label={deviceLabel()}
          >
            <Switch fallback={<Icon name="monitor" size="small" />}>
              <Match when={view.state.device === "tablet"}>
                <Icon name="tablet" size="small" />
              </Match>
              <Match when={view.state.device === "mobile"}>
                <Icon name="mobile" size="small" />
              </Match>
            </Switch>
          </button>
        </Tooltip>

        <div class="flex items-center gap-0.5 px-1 h-8 rounded-full border border-v2-border-border-base min-w-[96px] w-[min(240px,100%)] focus-within:border-v2-border-border-strong">
          <Tooltip value={ctx.t("reload.preview")} placement="bottom">
            <IconButton
              icon={<Icon name="refresh" size="small" />}
              variant="ghost-muted"
              size="small"
              class="hover:bg-transparent"
              disabled={!view.running()}
              onClick={() => view.reload()}
              aria-label={ctx.t("reload.preview")}
            />
          </Tooltip>
          <Menu
            gutter={4}
            modal={false}
            placement="bottom"
            onOpenChange={(open) => {
              if (!open) return setSearch("")
              queueMicrotask(() => searchInput?.focus())
            }}
          >
            <Menu.Trigger
              as="button"
              type="button"
              disabled={!view.running()}
              aria-label={ctx.t("address")}
              class="flex flex-1 min-w-0 h-full items-center justify-center gap-1.5 cursor-pointer select-none disabled:cursor-default disabled:opacity-50"
            >
              <span class="truncate text-12-regular text-v2-text-text-base">{label()}</span>
              <Icon name="chevron-down" size="small" />
            </Menu.Trigger>
            <Menu.Portal>
              <Menu.Content class="w-64">
                <div class="flex items-center gap-1.5 px-2 py-1.5 border-b border-v2-border-border-base">
                  <Icon name="magnifying-glass" size="small" class="shrink-0" />
                  <input
                    ref={searchInput}
                    value={search()}
                    onInput={(event) => setSearch(event.currentTarget.value)}
                    onKeyDown={(event) => {
                      event.stopPropagation()
                      const target = typed() ?? pages()[0]

                      if (event.key === "Enter" && target) view.go(target)
                    }}
                    placeholder={ctx.t("address.search")}
                    aria-label={ctx.t("address.search")}
                    spellcheck={false}
                    class="w-full min-w-0 bg-transparent border-0 outline-none text-12-regular text-v2-text-text-base placeholder:text-v2-text-text-faint"
                  />
                </div>
                <div class="mt-1 max-h-56 overflow-y-auto">
                  <For each={pages()}>
                    {(page) => (
                      <Menu.Item onSelect={() => view.go(page)}>
                        <span class="truncate flex-1 font-mono text-12-regular">
                          {page === "/" ? ctx.t("address.homepage") : page}
                        </span>
                        <Show when={view.state.path.split(/[?#]/)[0] === page}>
                          <Icon name="check" size="small" />
                        </Show>
                      </Menu.Item>
                    )}
                  </For>
                  <Show when={typed()}>
                    {(path) => (
                      <Menu.Item onSelect={() => view.go(path())}>
                        <Icon name="code" size="small" />
                        <span class="truncate">
                          {ctx.t("address.goTo")} <span class="font-mono">{path()}</span>
                        </span>
                      </Menu.Item>
                    )}
                  </Show>
                </div>
              </Menu.Content>
            </Menu.Portal>
          </Menu>
        </div>

        <Show when={!compact()}>
          <Tooltip value={ctx.t("open.browser")} placement="bottom">
            <IconButton
              icon={<Icon name="outline-square-arrow" size="small" />}
              variant="ghost-muted"
              disabled={!view.running()}
              onClick={() => {
                const href = view.href()

                if (href) window.open(href, "_blank", "noopener")
              }}
              aria-label={ctx.t("open.browser")}
            />
          </Tooltip>
          <Menu gutter={4} modal={false} placement="bottom">
            <Menu.Trigger
              as="button"
              type="button"
              aria-label={ctx.t("zoom")}
              class="flex shrink-0 items-center gap-0.5 h-7 px-1.5 rounded-md cursor-pointer text-12-regular text-v2-text-text-base tabular-nums hover:bg-v2-overlay-simple-overlay-hover"
            >
              {view.state.zoom}%
              <Icon name="chevron-down" size="small" />
            </Menu.Trigger>
            <Menu.Portal>
              <Menu.Content>
                <For each={ZOOM_OPTIONS}>
                  {(zoom) => (
                    <Menu.Item onSelect={() => view.setZoom(zoom)}>
                      <span class="flex-1 tabular-nums">{zoom}%</span>
                      <Show when={view.state.zoom === zoom}>
                        <Icon name="check" size="small" />
                      </Show>
                    </Menu.Item>
                  )}
                </For>
              </Menu.Content>
            </Menu.Portal>
          </Menu>
        </Show>
        <Menu gutter={4} modal={false} placement="bottom-end">
          <Menu.Trigger
            as={IconButton}
            icon={<Icon name="outline-dots" size="small" />}
            variant="ghost-muted"
            aria-label={ctx.t("more")}
          />
          <Menu.Portal>
            <Menu.Content>
              <Show when={view.running() || view.busy()}>
                <Menu.Item onSelect={() => view.restart()}>{ctx.t("restart")}</Menu.Item>
                <Menu.Item onSelect={() => view.stop()}>{ctx.t("stop")}</Menu.Item>
              </Show>
              <Show when={!view.running() && !view.busy()}>
                <Menu.Item onSelect={() => view.start({ retry: true })}>{ctx.t("start")}</Menu.Item>
              </Show>
              <Menu.Item onSelect={() => view.toggleLogs()}>
                {view.state.logs ? ctx.t("logs.hide") : ctx.t("logs.show")}
              </Menu.Item>
              <Show when={compact()}>
                <Menu.Separator />
                <Menu.Item
                  disabled={!view.running()}
                  onSelect={() => {
                    const href = view.href()

                    if (href) window.open(href, "_blank", "noopener")
                  }}
                >
                  {ctx.t("open.browser")}
                </Menu.Item>
                <For each={ZOOM_OPTIONS}>
                  {(zoom) => (
                    <Menu.Item onSelect={() => view.setZoom(zoom)}>
                      <span class="flex-1 tabular-nums">
                        {ctx.t("zoom")} {zoom}%
                      </span>
                      <Show when={view.state.zoom === zoom}>
                        <Icon name="check" size="small" />
                      </Show>
                    </Menu.Item>
                  )}
                </For>
              </Show>
            </Menu.Content>
          </Menu.Portal>
        </Menu>
      </div>

      <div class="flex shrink-0 items-center gap-1">
        <Tooltip value={ctx.t("publish.button")} placement="bottom">
          <button
            type="button"
            data-action="preview-publish"
            class="flex items-center gap-1.5 h-7 px-2 rounded-full cursor-pointer transition-colors hover:bg-v2-overlay-simple-overlay-hover text-12-medium text-v2-text-text-base"
            onClick={() => dialog.show(() => <PublishDialog />)}
            aria-label={ctx.t("publish.button")}
          >
            <Icon name="cloud-upload" size="small" />
            <span class="whitespace-nowrap" classList={{ hidden: compact() }}>
              {ctx.t("publish.button")}
            </span>
          </button>
        </Tooltip>
      </div>
    </div>
  )
}
