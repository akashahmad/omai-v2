import { Show } from "solid-js"
import {
  displayName,
  getProjectAvatarGenerated,
  getProjectAvatarSource,
  getProjectAvatarVariant,
  ProjectAvatar,
} from "@opencode/ui/project-avatar"
import { Button } from "@opencode/ui/button"
import { useDialog } from "@opencode/ui/context/dialog"
import { Dialog, DialogFooter, DialogHeader, DialogTitleGroup } from "@opencode/ui/dialog"
import { Icon } from "@opencode/ui/icon"
import { IconButton } from "@opencode/ui/icon-button"
import { Loader } from "@opencode/ui/loader"
import { Menu } from "@opencode/ui/menu"
import type { LocalProject } from "@/shell/state/layout"
import type { ProjectsController } from "./controller"

function Avatar(props: { project: LocalProject; class: string }) {
  return (
    <ProjectAvatar
      class={props.class}
      fallback={displayName(props.project)}
      src={getProjectAvatarSource(props.project.id, props.project.icon)}
      variant={getProjectAvatarVariant(props.project.icon?.color)}
      generated={getProjectAvatarGenerated(props.project)}
    />
  )
}

function ProjectMenu(props: { projects: ProjectsController; project: LocalProject }) {
  const dialog = useDialog()

  return (
    <Menu gutter={6} modal={false} placement="bottom-end">
      <Menu.Trigger
        as={IconButton}
        data-action="project-menu"
        variant="ghost-muted"
        size="small"
        icon={<Icon name="outline-dots" />}
        aria-label={props.projects.language.t("common.moreOptions")}
      />
      <Menu.Portal>
        <Menu.Content>
          <Menu.Item onSelect={() => props.projects.edit(props.project)}>
            <Icon name="edit" size="small" class="shrink-0" />
            {props.projects.language.t("common.edit")}
          </Menu.Item>
          <Menu.Separator />
          <Menu.Item
            data-variant="critical"
            onSelect={() =>
              dialog.show(() => <DeleteProjectDialog projects={props.projects} project={props.project} />)
            }
          >
            <Icon name="trash" size="small" class="shrink-0" />
            {props.projects.language.t("common.delete")}
          </Menu.Item>
        </Menu.Content>
      </Menu.Portal>
    </Menu>
  )
}

function DeleteProjectDialog(props: { projects: ProjectsController; project: LocalProject }) {
  const dialog = useDialog()
  const t = props.projects.language.t

  return (
    <Dialog fit>
      <DialogHeader hideClose>
        <DialogTitleGroup
          title={t("projects.delete.title")}
          description={t("projects.delete.confirm", { name: displayName(props.project) })}
        />
      </DialogHeader>
      <DialogFooter>
        <Button variant="ghost" autofocus onClick={() => dialog.close()}>
          {t("common.cancel")}
        </Button>
        <Button
          data-action="project-delete-confirm"
          variant="danger"
          onClick={() => {
            dialog.close()
            props.projects.remove(props.project)
          }}
        >
          {t("common.delete")}
        </Button>
      </DialogFooter>
    </Dialog>
  )
}

export function ProjectRow(props: { projects: ProjectsController; project: LocalProject }) {
  return (
    <li
      data-component="project-row"
      class="group flex items-center gap-1 rounded-[8px] pr-1 transition-colors hover:bg-v2-background-bg-layer-01"
    >
      <button
        type="button"
        class="flex min-w-0 flex-1 cursor-default items-center gap-3 px-3 py-2.5 text-left"
        onClick={() => void props.projects.open(props.project)}
      >
        <Avatar project={props.project} class="!size-6" />
        <span class="truncate text-14-medium text-v2-text-text-base">{displayName(props.project)}</span>
        <span class="min-w-0 flex-1 truncate text-12-regular text-v2-text-text-faint">{props.project.worktree}</span>
        <Show when={props.projects.opening() === props.project.worktree}>
          <Loader class="size-3.5 shrink-0 text-v2-text-text-muted" />
        </Show>
      </button>
      <ProjectMenu projects={props.projects} project={props.project} />
    </li>
  )
}

export function ProjectCard(props: { projects: ProjectsController; project: LocalProject }) {
  return (
    <div
      data-component="project-card"
      class="relative flex flex-col overflow-hidden rounded-[12px] border border-v2-border-border-muted bg-v2-background-bg-base transition-colors hover:bg-v2-background-bg-layer-01"
    >
      <button
        type="button"
        class="flex h-36 cursor-default items-center justify-center bg-v2-background-bg-layer-01"
        onClick={() => void props.projects.open(props.project)}
        aria-label={displayName(props.project)}
      >
        <Avatar project={props.project} class="!size-16 text-20-medium" />
      </button>
      <div class="flex items-center gap-2 p-3">
        <button
          type="button"
          class="flex min-w-0 flex-1 cursor-default flex-col gap-0.5 text-left"
          onClick={() => void props.projects.open(props.project)}
        >
          <span class="truncate text-14-medium text-v2-text-text-base">{displayName(props.project)}</span>
          <span class="truncate text-12-regular text-v2-text-text-faint">{props.project.worktree}</span>
        </button>
        <ProjectMenu projects={props.projects} project={props.project} />
      </div>
      <Show when={props.projects.opening() === props.project.worktree}>
        <div class="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-v2-background-bg-base/85 backdrop-blur-sm">
          <Loader class="size-5 text-v2-text-text-muted" />
          <span class="text-13-regular text-v2-text-text-muted">{props.projects.language.t("projects.opening")}</span>
        </div>
      </Show>
    </div>
  )
}

export function ProjectsEmpty(props: { title: string; description: string }) {
  return (
    <div class="mx-auto mt-24 flex flex-col items-center gap-3 text-center">
      <Icon name="folder-add-left" class="size-6 text-v2-text-text-muted" />
      <div class="flex flex-col gap-1">
        <div class="text-14-medium text-v2-text-text-base">{props.title}</div>
        <div class="text-12-regular text-v2-text-text-muted">{props.description}</div>
      </div>
    </div>
  )
}
