import { useNavigate } from "@solidjs/router"
import { createMemo, For, type ParentProps, Show } from "solid-js"
import { Button } from "@opencode/ui/button"
import { Loader } from "@opencode/ui/loader"
import { ScrollView } from "@opencode/ui/scroll-view"
import { createProjectsController } from "./controller"
import { BrandIcon } from "@/shell/brand-icon"
import { ProjectRow, ProjectsEmpty } from "./item"

const RECENT_LIMIT = 5

/** The site's start page: recent projects, and creating new ones. */
export function ProjectsLanding() {
  const navigate = useNavigate()
  const projects = createProjectsController()
  const recent = createMemo(() => projects.list().slice(0, RECENT_LIMIT))

  return (
    <ProjectsPanel>
      <div class="mx-auto flex w-full max-w-2xl flex-col gap-3 px-4 pt-14 pb-8">
        <div class="mb-8 flex justify-center">
          <BrandIcon label="O M A I +" class="size-20 rounded-[12px]" />
        </div>
        <div class="flex items-center justify-between gap-2 pl-1">
          <div class="text-13-regular text-v2-text-text-muted">{projects.language.t("projects.title")}</div>
          <div class="flex gap-2">
            <Button data-action="projects-new" icon="folder-add-left" onClick={projects.create}>
              {projects.language.t("projects.new")}
            </Button>
            <Button data-action="projects-all" icon="folder" onClick={() => navigate("/projects")}>
              {projects.language.t("projects.all")}
            </Button>
          </div>
        </div>
        <div class="h-px bg-v2-border-border-muted" />
        <Show
          when={recent().length > 0}
          fallback={
            <Show
              when={projects.ready()}
              fallback={
                <div class="mt-24 flex justify-center">
                  <Loader class="size-5 text-v2-text-text-muted" />
                </div>
              }
            >
              <ProjectsEmpty
                title={projects.language.t("projects.empty.title")}
                description={projects.language.t("projects.empty.description")}
              />
            </Show>
          }
        >
          <ul class="flex flex-col gap-0.5">
            <For each={recent()}>{(project) => <ProjectRow projects={projects} project={project} />}</For>
          </ul>
        </Show>
        <Show when={projects.list().length > RECENT_LIMIT}>
          <button
            type="button"
            class="mx-auto mt-1 cursor-default text-12-regular text-v2-text-text-muted transition-colors hover:text-v2-text-text-base"
            onClick={() => navigate("/projects")}
          >
            {projects.language.t("projects.showAll", { count: projects.list().length })}
          </button>
        </Show>
      </div>
    </ProjectsPanel>
  )
}

export function ProjectsPanel(props: ParentProps) {
  return (
    <div
      data-slot="projects-panel"
      class={`
        mx-[var(--shell-inline-inset,8px)] mb-[var(--shell-bottom-inset,8px)] mt-[var(--shell-top-inset,8px)] flex min-h-0 flex-1 flex-col self-stretch overflow-hidden rounded-[6px]
        bg-v2-background-bg-base shadow-[var(--v2-elevation-raised)]
      `}
    >
      <ScrollView class="min-h-0 flex-1">{props.children}</ScrollView>
    </div>
  )
}
