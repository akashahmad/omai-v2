import { createMemo, createSignal, For, Match, onCleanup, Show, Switch } from "solid-js"
import { usePlugin } from "@opencode/plugin/gui"
import { Icon } from "@opencode/ui/icon"
import { IconButton } from "@opencode/ui/icon-button"
import { Loader } from "@opencode/ui/loader"
import { Menu } from "@opencode/ui/menu"
import { Tooltip } from "@opencode/ui/tooltip"
import { PublishDialog } from "./publish-dialog"
import type { PublishState } from "./publish"
import { ZOOM_OPTIONS, type Device, type PreviewView } from "./view"

const NEXT_DEVICE: Record<Device, Device> = { desktop: "tablet", tablet: "mobile", mobile: "desktop" }

const kbd =
  "inline-flex h-[18px] min-w-[18px] items-center justify-center rounded border border-v2-border-border-base bg-v2-background-bg-base px-1 font-sans text-[10px] text-v2-text-text-muted"

// Below this width the zoom and open-in-browser controls move into the options menu.
const COMPACT_WIDTH = 380

/** The preview's controls in the right panel's toolbar: device, address, open in browser, zoom, options, Publish. */
export function PreviewToolbar(props: { view: PreviewView; publish: PublishState }) {
  const ctx = usePlugin()
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
              <Menu.Content
                data-component="preview-routes"
                class="w-[300px] !p-1.5 !rounded-xl border border-v2-border-border-base"
              >
                <div class="mb-1.5 flex h-9 items-center gap-2 rounded-lg border border-v2-border-border-base bg-v2-background-bg-base px-2.5 transition-[border-color,box-shadow] focus-within:border-[#1a64d6] focus-within:shadow-[0_0_0_3px_rgb(26_100_214/0.15)]">
                  <Icon name="magnifying-glass" size="small" class="shrink-0 text-v2-icon-icon-muted" />
                  <input
                    ref={searchInput}
                    value={search()}
                    onInput={(event) => setSearch(event.currentTarget.value)}
                    onKeyDown={(event) => {
                      event.stopPropagation()

                      // Down moves from the search into the list, where the menu's own keys take over.
                      if (event.key === "ArrowDown") {
                        event.preventDefault()
                        event.currentTarget.closest('[role="menu"]')?.querySelector<HTMLElement>('[role="menuitem"]')?.focus()

                        return
                      }

                      const target = typed() ?? pages()[0]

                      if (event.key === "Enter" && target) view.go(target)
                    }}
                    placeholder={ctx.t("address.search")}
                    aria-label={ctx.t("address.search")}
                    spellcheck={false}
                    autocomplete="off"
                    class="w-full min-w-0 bg-transparent border-0 outline-none text-[13px] text-v2-text-text-base placeholder:text-v2-text-text-faint"
                  />
                </div>
                <Show when={typed()}>
                  {(path) => (
                    <Menu.Item
                      class="!h-9 !rounded-lg !px-1.5 cursor-pointer"
                      onSelect={() => view.go(path())}
                    >
                      <span class="flex size-6 shrink-0 items-center justify-center rounded-md bg-[#1a64d6]/12 text-[#1a64d6]">
                        <Icon name="outline-arrow-right" size="small" />
                      </span>
                      <span class="min-w-0 flex-1 truncate text-[13px]">
                        {ctx.t("address.goTo")} <span class="font-mono text-[12px]">{path()}</span>
                      </span>
                      <kbd class={kbd}>↵</kbd>
                    </Menu.Item>
                  )}
                </Show>
                <Show when={pages().length > 0}>
                  <div class="flex items-center justify-between px-2 pb-1 pt-1.5 text-[11px] font-medium uppercase tracking-[0.04em] text-v2-text-text-faint">
                    <span>{ctx.t("address.pages")}</span>
                    <span class="tabular-nums">{pages().length}</span>
                  </div>
                </Show>
                <div class="max-h-64 overflow-y-auto">
                  <For each={pages()}>
                    {(page) => {
                      const current = () => view.state.path.split(/[?#]/)[0] === page

                      return (
                        <Menu.Item
                          class="!h-9 !rounded-lg !px-1.5 cursor-pointer"
                          classList={{ "!bg-[#1a64d6]/10": current() }}
                          onSelect={() => view.go(page)}
                        >
                          <span
                            class="flex size-6 shrink-0 items-center justify-center rounded-md"
                            classList={{
                              "bg-[#1a64d6]/15 text-[#1a64d6]": current(),
                              "bg-v2-overlay-simple-overlay-hover text-v2-icon-icon-muted": !current(),
                            }}
                          >
                            <Show when={page === "/"} fallback={<Icon name="file-document" size="small" />}>
                              <HomeIcon />
                            </Show>
                          </span>
                          <span class="flex min-w-0 flex-1 items-baseline gap-2">
                            <Show
                              when={page === "/"}
                              fallback={<span class="truncate font-mono text-[12px]">{page}</span>}
                            >
                              <span class="truncate text-[13px]">{ctx.t("address.homepage")}</span>
                              <span class="shrink-0 font-mono text-[11px] text-v2-text-text-faint">/</span>
                            </Show>
                          </span>
                          <Show when={current()}>
                            <Icon name="check" size="small" class="shrink-0 text-[#1a64d6]" />
                          </Show>
                        </Menu.Item>
                      )
                    }}
                  </For>
                </div>
                <div class="mt-1.5 flex items-center gap-3 border-t border-v2-border-border-base px-2 pt-2 pb-0.5 text-[11px] text-v2-text-text-faint">
                  <span class="flex items-center gap-1">
                    <kbd class={kbd}>↑</kbd>
                    <kbd class={kbd}>↓</kbd>
                    {ctx.t("address.hint.move")}
                  </span>
                  <span class="flex items-center gap-1">
                    <kbd class={kbd}>↵</kbd>
                    {ctx.t("address.hint.open")}
                  </span>
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
                <Menu.Item onSelect={() => view.restart()}>
                  <Icon name="outline-rotate-clockwise" size="small" class="shrink-0 text-v2-text-text-muted" />
                  <span class="flex-1">{ctx.t("restart")}</span>
                </Menu.Item>
                <Menu.Item onSelect={() => view.stop()}>
                  <Icon name="stop" size="small" class="shrink-0 text-v2-text-text-muted" />
                  <span class="flex-1">{ctx.t("stop")}</span>
                </Menu.Item>
              </Show>
              <Show when={!view.running() && !view.busy()}>
                <Menu.Item onSelect={() => view.start({ retry: true })}>
                  <Icon name="outline-arrow-right" size="small" class="shrink-0 text-v2-text-text-muted" />
                  <span class="flex-1">{ctx.t("start")}</span>
                </Menu.Item>
              </Show>
              <Menu.Item onSelect={() => view.toggleLogs()}>
                <Icon name="outline-console" size="small" class="shrink-0 text-v2-text-text-muted" />
                <span class="flex-1">{view.state.logs ? ctx.t("logs.hide") : ctx.t("logs.show")}</span>
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
                  <Icon name="square-arrow-top-right" size="small" class="shrink-0 text-v2-text-text-muted" />
                  <span class="flex-1">{ctx.t("open.browser")}</span>
                </Menu.Item>
                <For each={ZOOM_OPTIONS}>
                  {(zoom) => (
                    <Menu.Item onSelect={() => view.setZoom(zoom)}>
                      <Icon name="outline-magnifier-plus" size="small" class="shrink-0 text-v2-text-text-muted" />
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
            onClick={() => ctx.dialogs.open(() => <PublishDialog publish={props.publish} />)}
            aria-label={ctx.t("publish.button")}
          >
            <Switch fallback={<Icon name="cloud-upload" size="small" />}>
              <Match when={props.publish.running()}>
                <Loader width={14} height={14} />
              </Match>
              <Match when={props.publish.live()}>
                {/* The site is live: the cloud carries a small green dot. */}
                <span class="relative flex">
                  <Icon name="cloud-upload" size="small" />
                  <span
                    aria-hidden="true"
                    class="absolute -top-0.5 -end-0.5 size-[7px] rounded-full bg-[#3f8f6a] shadow-[0_0_0_1.5px_var(--v2-background-bg-base)]"
                  />
                </span>
              </Match>
            </Switch>
            <span class="whitespace-nowrap" classList={{ hidden: compact() }}>
              {ctx.t("publish.button")}
            </span>
          </button>
        </Tooltip>
      </div>
    </div>
  )
}

function HomeIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" class="size-3.5">
      <path
        d="M2.75 7.25 8 2.75l5.25 4.5v5.5a.75.75 0 0 1-.75.75H9.75V9.75h-3.5v3.75H3.5a.75.75 0 0 1-.75-.75v-5.5Z"
        stroke="currentColor"
        stroke-width="1.3"
        stroke-linejoin="round"
      />
    </svg>
  )
}
