import { createMemo, createSignal, For, Show } from "solid-js"
import { displayName } from "@opencode/ui/project-avatar"
import { Button } from "@opencode/ui/button"
import { Icon } from "@opencode/ui/icon"
import { IconButton } from "@opencode/ui/icon-button"
import { Loader } from "@opencode/ui/loader"
import { createProjectsController } from "./controller"
import { ProjectCard, ProjectRow, ProjectsEmpty } from "./item"
import { ProjectsPanel } from "./landing"

const PAGE_SIZE = 9

/** Every project, searchable, as a grid or a list. */
export function AllProjects() {
  const projects = createProjectsController()
  const t = projects.language.t
  const [view, setView] = createSignal<"grid" | "list">("grid")
  const [query, setQuery] = createSignal("")
  const [page, setPage] = createSignal(1)

  const filtered = createMemo(() => {
    const needle = query().trim().toLowerCase()

    if (!needle) return projects.list()

    return projects
      .list()
      .filter(
        (project) =>
          displayName(project).toLowerCase().includes(needle) || project.worktree.toLowerCase().includes(needle),
      )
  })

  const pages = createMemo(() => Math.max(1, Math.ceil(filtered().length / PAGE_SIZE)))
  const current = createMemo(() => Math.min(page(), pages()))
  const visible = createMemo(() => filtered().slice((current() - 1) * PAGE_SIZE, current() * PAGE_SIZE))

  return (
    <ProjectsPanel>
      <div class="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 pt-6 pb-8">
        <div class="flex items-center justify-between gap-3">
          <div class="flex items-center gap-2">
            <Icon name="folder" class="text-v2-text-text-muted" />
            <h1 class="text-16-medium text-v2-text-text-base">{t("projects.title")}</h1>
          </div>
          <Button data-action="projects-new" icon="folder-add-left" onClick={projects.create}>
            {t("projects.new")}
          </Button>
        </div>

        <div class="flex items-center justify-between gap-3">
          <label class="relative w-full max-w-md">
            <Icon
              name="magnifying-glass"
              class="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-v2-text-text-faint"
            />
            <input
              type="search"
              data-action="projects-search"
              placeholder={t("projects.search.placeholder")}
              value={query()}
              onInput={(event) => {
                setQuery(event.currentTarget.value)
                setPage(1)
              }}
              class={`
                w-full rounded-[8px] border border-v2-border-border-muted bg-v2-background-bg-layer-01 py-2 pl-9 pr-3
                text-14-regular text-v2-text-text-base placeholder:text-v2-text-text-faint focus:outline-none
                focus:[box-shadow:0_0_0_1px_var(--v2-border-border-base)]
              `}
            />
          </label>
          <div class="flex items-center gap-1 rounded-[8px] border border-v2-border-border-muted p-0.5">
            <IconButton
              data-action="projects-view-grid"
              variant={view() === "grid" ? "ghost" : "ghost-muted"}
              size="small"
              icon={<Icon name="grid-plus" />}
              aria-label={t("projects.view.grid")}
              aria-pressed={view() === "grid"}
              onClick={() => setView("grid")}
            />
            <IconButton
              data-action="projects-view-list"
              variant={view() === "list" ? "ghost" : "ghost-muted"}
              size="small"
              icon={<Icon name="menu" />}
              aria-label={t("projects.view.list")}
              aria-pressed={view() === "list"}
              onClick={() => setView("list")}
            />
          </div>
        </div>

        <Show
          when={visible().length > 0}
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
                title={query() ? t("projects.search.empty", { query: query() }) : t("projects.empty.title")}
                description={query() ? t("projects.search.emptyDescription") : t("projects.empty.description")}
              />
            </Show>
          }
        >
          <Show
            when={view() === "grid"}
            fallback={
              <ul class="flex flex-col gap-0.5">
                <For each={visible()}>{(project) => <ProjectRow projects={projects} project={project} />}</For>
              </ul>
            }
          >
            <div class="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <For each={visible()}>{(project) => <ProjectCard projects={projects} project={project} />}</For>
            </div>
          </Show>
        </Show>

        <Show when={pages() > 1}>
          <nav class="flex items-center justify-center gap-2" aria-label={t("projects.title")}>
            <Button variant="ghost" disabled={current() === 1} onClick={() => setPage(current() - 1)}>
              {t("projects.pagination.previous")}
            </Button>
            <For each={Array.from({ length: pages() }, (_, index) => index + 1)}>
              {(item) => (
                <Button
                  variant={item === current() ? "neutral" : "ghost-muted"}
                  aria-current={item === current() ? "page" : undefined}
                  onClick={() => setPage(item)}
                >
                  {item}
                </Button>
              )}
            </For>
            <Button variant="ghost" disabled={current() === pages()} onClick={() => setPage(current() + 1)}>
              {t("projects.pagination.next")}
            </Button>
          </nav>
        </Show>

        <Show when={projects.list().length > 0}>
          <div class="text-center text-12-regular text-v2-text-text-muted">
            {t("projects.results", { count: filtered().length, total: projects.list().length })}
          </div>
        </Show>
      </div>
    </ProjectsPanel>
  )
}
