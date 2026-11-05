import { For, Show, type JSX } from "solid-js"
import { usePlugin, type MountedSession, type SessionScreen } from "@opencode/plugin/gui"
import { Icon } from "@opencode/ui/icon"
import type { IconName } from "@opencode/ui/icons/catalog"
import { useShared } from "./context"
import { describe, type DownloadTarget, type Failure } from "./download"
import type { TreeMenu, TreeMenuItem } from "./pierre-tree"

export type MenuEntry = {
  readonly label: string
  readonly icon: IconName | "download"
  readonly danger?: boolean
  readonly separated?: boolean
  run(): void
}

/** A compact action menu, for the tree's "⋯" button and the project rows. */
export function MenuList(props: { label: string; items: readonly MenuEntry[]; onDone?: () => void }) {
  return (
    <div
      role="menu"
      aria-label={props.label}
      data-component="file-tree-menu"
      class="w-full min-w-[184px] rounded-[10px] border border-v2-border-border-base bg-v2-background-bg-base p-1 text-[13px] text-v2-text-text-base shadow-[0_10px_30px_rgb(0_0_0/0.18)]"
    >
      <For each={props.items}>
        {(item) => (
          <>
            <Show when={item.separated}>
              <div class="mx-1 my-1 h-px bg-v2-border-border-base" />
            </Show>
            <button
              type="button"
              role="menuitem"
              class="flex h-8 w-full cursor-pointer items-center gap-2.5 rounded-[7px] px-2 text-start outline-none hover:bg-v2-overlay-simple-overlay-hover focus-visible:bg-v2-overlay-simple-overlay-hover"
              classList={{ "text-v2-state-fg-danger": item.danger }}
              onClick={() => {
                props.onDone?.()
                item.run()
              }}
            >
              <span class="flex size-4 shrink-0 items-center justify-center" classList={{ "text-v2-icon-icon-muted": !item.danger }}>
                <Show when={item.icon !== "download" ? item.icon : undefined} fallback={<DownloadIcon />}>
                  {(name) => <Icon name={name()} size="small" />}
                </Show>
              </span>
              <span class="truncate">{item.label}</span>
            </button>
          </>
        )}
      </For>
    </div>
  )
}

export function DownloadIcon(props: { class?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" class={props.class ?? "size-4"}>
      <path d="M8 2.5v7.5m0 0 3-3m-3 3-3-3M3 12.5h10" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  )
}

/** The rows' "⋯" menu and inline renaming for the workspace tree. */
export function createTreeMenu(props: { session: MountedSession; screen: SessionScreen }): TreeMenu {
  const ctx = usePlugin()
  const shared = useShared()
  const file = props.screen.file

  const rpc = async () => {
    const { Files } = await import("@opencode/schema/files")

    return {
      client: props.session.server.client.rpc(Files.Definition),
      options: { location: { directory: props.session.directory } },
    }
  }

  const parent = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "")
  const reload = (...paths: string[]) => new Set(paths).forEach((path) => void file.tree.sync(path, { force: true }))

  const remove = async (item: TreeMenuItem) => {
    const folder = item.kind === "directory"

    const confirmed = await ctx.dialogs.confirm({
      title: ctx.t(folder ? "delete.title.folder" : "delete.title.file"),
      description: ctx.t(folder ? "delete.body.folder" : "delete.body.file", { name: item.path }),
      confirm: ctx.t("delete.confirm"),
      cancel: ctx.t("delete.cancel"),
      danger: true,
    })

    if (!confirmed) return
    const { client, options } = await rpc()

    const failed = await client.remove({ path: item.path }, options).then(
      () => undefined,
      (error: Failure) => describe(error),
    )

    if (failed) return ctx.toast.show({ variant: "error", title: ctx.t("delete.failed", { name: item.name }), description: failed })
    reload(parent(item.path))
    ctx.toast.show({ variant: "success", title: ctx.t("delete.done", { name: item.name }) })
  }

  const download = (item: TreeMenuItem) => {
    const target: DownloadTarget = { kind: item.kind === "directory" ? "folder" : "file", path: item.path }

    shared.downloads.start(props.session, target, item.kind === "directory" ? `${item.name}.zip` : item.name)
  }

  const copy = (item: TreeMenuItem) =>
    void ctx.system.copy(file.resolve(item.path)).then(
      () => ctx.toast.show({ variant: "success", title: ctx.t("copied"), description: item.path }),
      () => ctx.toast.show({ variant: "error", title: ctx.t("copyFailed") }),
    )

  return {
    render: (item, actions): JSX.Element => (
      <MenuList
        label={ctx.t("menu.label", { name: item.name })}
        onDone={actions.close}
        items={[
          ...(item.kind === "file"
            ? [{ label: ctx.t("menu.open"), icon: "file-document" as const, run: () => shared.open(props.session, item.path) }]
            : []),
          {
            label: ctx.t(item.kind === "directory" ? "menu.downloadZip" : "menu.download"),
            icon: "download",
            run: () => download(item),
          },
          { label: ctx.t("menu.rename"), icon: "edit", run: actions.rename },
          { label: ctx.t("menu.copyPath"), icon: "outline-copy", run: () => copy(item) },
          { label: ctx.t("menu.delete"), icon: "outline-trash", danger: true, separated: true, run: () => void remove(item) },
        ]}
      />
    ),
    async rename(from, to) {
      const { client, options } = await rpc()

      const failed = await client.rename({ from, to }, options).then(
        () => undefined,
        (error: Failure) => describe(error),
      )

      if (failed) {
        ctx.toast.show({ variant: "error", title: ctx.t("rename.failed", { name: from.split("/").at(-1) ?? from }), description: failed })

        return false
      }

      reload(parent(from), parent(to))

      return true
    },
  }
}

