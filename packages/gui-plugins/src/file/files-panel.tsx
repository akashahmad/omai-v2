import { createSignal, Match, onCleanup, Show, Switch, type JSX } from "solid-js"
import type { ChangeKind } from "@opencode/plugin/gui/review"
import { createKeyed, usePlugin, type MountedSession, type SessionScreen } from "@opencode/plugin/gui"
import { Icon } from "@opencode/ui/icon"
import { current, useShared } from "./context"
import type { DownloadState, DownloadTarget } from "./download"
import PierreFileTree from "./pierre-tree"
import { createTreeMenu, DownloadIcon, MenuList, type MenuEntry } from "./tree-actions"

const PROJECT: DownloadTarget = { kind: "project" }

/** The narrow "All files" column: the project as a root folder, its tree, and the project zip beside it. */
export default function FilesPanel(props: { session: MountedSession; screen: SessionScreen }) {
  const ctx = usePlugin()
  const shared = useShared()
  const empty = new Map<string, ChangeKind>()
  const changes = () => current(shared.changes())
  const menu = createTreeMenu(props)
  const [open, setOpen] = createSignal(true)

  // Change markers in the tree load while the column shows.
  createKeyed(changes, (service) => onCleanup(service.watch(props.screen, "files")))

  const name = () =>
    (
      props.session.listedProject?.name ??
      props.session.project?.name ??
      props.session.directory.split(/[\\/]/).filter(Boolean).at(-1) ??
      "project"
    ).replace(/[\\/:*?"<>|]+/g, "-")

  const zip = () => `${name()}.zip`
  const download = () => shared.downloads.get(props.session, PROJECT)
  const startDownload = () => shared.downloads.start(props.session, PROJECT, zip())

  const rootItems = (): MenuEntry[] => [
    { label: ctx.t("menu.downloadZip"), icon: "download", run: startDownload },
    {
      label: ctx.t("menu.refresh"),
      icon: "refresh",
      run: () => void props.screen.file.tree.sync("", { force: true }),
    },
    {
      label: ctx.t("menu.copyPath"),
      icon: "outline-copy",
      run: () =>
        void ctx.system.copy(props.session.directory).then(
          () => ctx.toast.show({ variant: "success", title: ctx.t("copied"), description: props.session.directory }),
          () => ctx.toast.show({ variant: "error", title: ctx.t("copyFailed") }),
        ),
    },
  ]

  return (
    <div data-component="session-files-panel" class="flex h-full min-h-0 flex-col">
      <div class="flex h-10 shrink-0 items-center justify-center border-b border-v2-border-border-base px-3 text-14-medium text-v2-text-text-base">
        {ctx.t("tree.all")}
      </div>
      <div class="group/files flex min-h-0 flex-1 flex-col pt-1">
        <Row
          data-slot="files-project-root"
          title={props.session.directory}
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open()}
          menu={{ label: ctx.t("menu.label", { name: name() }), items: rootItems() }}
        >
          <Icon
            name="outline-chevron-right"
            size="small"
            class="shrink-0 text-v2-icon-icon-muted transition-transform duration-150 rtl:rotate-180"
            classList={{ "rotate-90 rtl:rotate-90": open() }}
          />
          <Icon name="folder" size="small" class="shrink-0 text-v2-icon-icon-muted" />
          <span class="truncate text-[13px] font-medium text-v2-text-text-base">{name()}</span>
        </Row>
        <div class="relative min-h-0 flex-1" classList={{ hidden: !open() }}>
          {/* The root's indent guide, in line with the chevron above; it shows while the pointer is over the files. */}
          <div
            aria-hidden="true"
            class="pointer-events-none absolute inset-y-0 start-[19px] w-px bg-v2-border-border-base opacity-0 transition-opacity duration-150 group-hover/files:opacity-60 motion-reduce:transition-none"
          />
          <div class="h-full ps-3">
            <PierreFileTree
              session={props.session}
              screen={props.screen}
              kinds={changes()?.kinds(props.session) ?? empty}
              draggable
              menu={menu}
              onFileClick={(node) => shared.open(props.session, node.path, { tab: "preview" })}
              onFileDoubleClick={(node) => shared.open(props.session, node.path)}
            />
          </div>
        </div>
        <div class="shrink-0 border-t border-v2-border-border-base/60 pb-2 pt-1" classList={{ "mt-auto": !open() }}>
          <ZipRow
            name={zip()}
            state={download()}
            onDownload={startDownload}
            onCancel={() => shared.downloads.cancel(props.session, PROJECT)}
          />
        </div>
      </div>
    </div>
  )
}

/** A project row: the whole row acts, and a "⋯" button opens its menu. */
function Row(props: {
  children: JSX.Element
  title: string
  onClick: () => void
  menu: { label: string; items: MenuEntry[] }
  "aria-expanded"?: boolean
  "data-slot": string
  /** Opens the menu above the row, for rows at the bottom of the panel. */
  up?: boolean
}) {
  const [menuOpen, setMenuOpen] = createSignal(false)
  let anchor: HTMLDivElement | undefined

  const close = (event: PointerEvent) => {
    if (anchor?.contains(event.target instanceof Node ? event.target : null)) return
    setMenuOpen(false)
  }

  const escape = (event: KeyboardEvent) => {
    if (event.key === "Escape") setMenuOpen(false)
  }

  document.addEventListener("pointerdown", close, true)
  document.addEventListener("keydown", escape)
  onCleanup(() => {
    document.removeEventListener("pointerdown", close, true)
    document.removeEventListener("keydown", escape)
  })

  return (
    <div ref={anchor} class="group/row relative mx-2 shrink-0" data-slot={props["data-slot"]}>
      <button
        type="button"
        title={props.title}
        aria-expanded={props["aria-expanded"]}
        class="flex h-7 w-full cursor-pointer items-center gap-1.5 rounded-md px-1.5 pe-8 text-start hover:bg-v2-overlay-simple-overlay-hover"
        classList={{ "bg-v2-overlay-simple-overlay-hover": menuOpen() }}
        onClick={() => props.onClick()}
        onContextMenu={(event) => {
          event.preventDefault()
          setMenuOpen(true)
        }}
      >
        {props.children}
      </button>
      <button
        type="button"
        aria-label={props.menu.label}
        aria-haspopup="menu"
        aria-expanded={menuOpen()}
        class="absolute end-1 top-1 flex size-5 cursor-pointer items-center justify-center rounded text-v2-icon-icon-muted opacity-0 hover:bg-v2-overlay-simple-overlay-hover group-hover/row:opacity-100 focus-visible:opacity-100"
        classList={{ "opacity-100": menuOpen() }}
        onClick={() => setMenuOpen((value) => !value)}
      >
        <Icon name="outline-dots" size="small" />
      </button>
      <Show when={menuOpen()}>
        <div class="absolute end-0 z-30" classList={{ "top-7": !props.up, "bottom-7": props.up }}>
          <MenuList label={props.menu.label} items={props.menu.items} onDone={() => setMenuOpen(false)} />
        </div>
      </Show>
    </div>
  )
}

/** The project zip: a click downloads it, with live progress while the server zips and the browser downloads. */
function ZipRow(props: { name: string; state?: DownloadState; onDownload: () => void; onCancel: () => void }) {
  const ctx = usePlugin()
  const percent = () => Math.round(Math.min(1, props.state?.progress ?? 0) * 100)

  const label = () => {
    const state = props.state

    if (!state) return ""

    if (state.phase === "scanning") return ctx.t("download.scanning")

    if (state.phase === "zipping") return ctx.t("download.zipping", { percent: percent() })

    if (state.phase === "downloading")
      return state.progress === undefined ? ctx.t("download.starting") : ctx.t("download.downloading", { percent: percent() })

    return ""
  }

  // Zipping fills the first 70% of the bar and downloading the rest, so the bar never moves backwards.
  const bar = () => {
    const state = props.state

    if (!state || state.progress === undefined) return undefined

    if (state.phase === "zipping") return state.progress * 70

    if (state.phase === "downloading") return 70 + state.progress * 30

    return undefined
  }

  return (
    <Switch
      fallback={
        <Row
          data-slot="files-project-zip"
          up
          title={`${ctx.t("tree.zip.hint")}. ${ctx.t("tree.zip.excluded")}`}
          onClick={props.onDownload}
          menu={{
            label: ctx.t("menu.label", { name: props.name }),
            items: [{ label: ctx.t("menu.download"), icon: "download", run: props.onDownload }],
          }}
        >
          <span class="size-4 shrink-0" />
          <Icon name="archive" size="small" class="shrink-0 text-v2-icon-icon-muted" />
          <span class="truncate text-[13px] text-v2-text-text-muted">{props.name}</span>
          <DownloadIcon class="ms-auto size-3.5 shrink-0 text-v2-icon-icon-muted opacity-0 group-hover/row:opacity-100" />
        </Row>
      }
    >
      <Match when={props.state?.phase === "failed" ? props.state : undefined}>
        {(state) => (
          <div data-slot="files-project-zip" class="mx-2 flex flex-col gap-1.5 rounded-md bg-v2-state-bg-danger px-2.5 py-2">
            <div class="flex items-center gap-1.5 text-[12px] font-medium text-v2-state-fg-danger">
              <Icon name="circle-exclamation" size="small" class="shrink-0" />
              <span class="truncate">{ctx.t("download.failed", { name: props.name })}</span>
            </div>
            <p class="line-clamp-3 break-words text-[12px] leading-[1.4] text-v2-text-text-muted">{state().error}</p>
            <div class="flex gap-1.5">
              <button
                type="button"
                class="h-6 cursor-pointer rounded-md bg-[#0a3a78] px-2.5 text-[12px] font-medium text-white hover:bg-[#082f62]"
                onClick={props.onDownload}
              >
                {ctx.t("download.retry")}
              </button>
              <button
                type="button"
                class="h-6 cursor-pointer rounded-md px-2 text-[12px] text-v2-text-text-muted hover:bg-v2-overlay-simple-overlay-hover"
                onClick={props.onCancel}
              >
                {ctx.t("download.dismiss")}
              </button>
            </div>
          </div>
        )}
      </Match>
      <Match when={props.state}>
        {(state) => (
          <div data-slot="files-project-zip" aria-busy="true" class="mx-2 flex flex-col gap-1.5 rounded-md px-1.5 py-1.5">
            <div class="flex h-5 items-center gap-1.5">
              <span class="size-4 shrink-0" />
              <Icon name="archive" size="small" class="shrink-0 text-[#1a64d6]" />
              <span class="min-w-0 flex-1 truncate text-[13px] text-v2-text-text-base">{props.name}</span>
              <button
                type="button"
                aria-label={ctx.t("download.cancel")}
                title={ctx.t("download.cancel")}
                class="flex size-5 shrink-0 cursor-pointer items-center justify-center rounded text-v2-icon-icon-muted hover:bg-v2-overlay-simple-overlay-hover"
                onClick={props.onCancel}
              >
                <Icon name="xmark-small" size="small" />
              </button>
            </div>
            <div class="ps-[22px]">
              <div
                role="progressbar"
                aria-label={label()}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={bar() === undefined ? undefined : Math.round(bar() ?? 0)}
                class="relative h-1 overflow-hidden rounded-full bg-v2-border-border-base"
              >
                <Show
                  when={bar()}
                  fallback={<div class="absolute inset-y-0 w-1/3 animate-[files-indeterminate_1.1s_ease-in-out_infinite] rounded-full bg-[#1a64d6]" />}
                >
                  {(width) => (
                    <div class="h-full rounded-full bg-[#1a64d6] transition-[width] duration-200" style={{ width: `${width()}%` }} />
                  )}
                </Show>
              </div>
              <div class="mt-1 flex items-center justify-between gap-2 text-[11px] tabular-nums text-v2-text-text-muted">
                <span class="truncate">{label()}</span>
                <Show when={state().phase === "zipping" && state().total ? state() : undefined}>
                  {(zipping) => (
                    <span class="shrink-0">
                      {ctx.t("download.files", {
                        files: (zipping().files ?? 0).toLocaleString(),
                        total: (zipping().total ?? 0).toLocaleString(),
                      })}
                    </span>
                  )}
                </Show>
              </div>
            </div>
          </div>
        )}
      </Match>
    </Switch>
  )
}
