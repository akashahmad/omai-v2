import { createSignal } from "solid-js"
import { createHomeController } from "@/home/model"
import { createHomeProjectsController } from "@/home/projects/controller"
import { useLanguage } from "@/runtime/i18n/language"
import { errorMessage } from "@/shell/layout/helpers"
import { showToast } from "@/shell/notifications/toast"
import type { LocalProject } from "@/shell/state/layout"

export function createProjectsController() {
  const home = createHomeController()
  const actions = createHomeProjectsController(home)
  const language = useLanguage()
  const [opening, setOpening] = createSignal<string>()

  // Opens the project's most recently updated session, or starts one when the project has none yet.
  async function open(project: LocalProject) {
    const conn = home.server.focused()

    if (!conn || opening()) return
    setOpening(project.worktree)
    const ctx = home.server.context(conn)

    try {
      const page = await ctx.sdk.api.session.list({
        ...(project.id ? { project: project.id } : { directory: project.worktree }),
        parentID: null,
        archived: false,
        order: "desc",
        limit: 1,
      })

      const session =
        page.data[0] ??
        (await ctx.data.session.create({ location: { directory: project.worktree }, projectID: project.id }).request)

      home.project.openProjectSession(conn, project.worktree, session)
    } catch (cause) {
      showToast({
        title: language.t("common.requestFailed"),
        description: errorMessage(cause, language.t("common.requestFailed")),
      })
    } finally {
      setOpening(undefined)
    }
  }

  return {
    language,
    list: home.project.list,
    opening,
    open,
    create: () => {
      const conn = home.server.focused()

      if (conn) actions.project.choose(conn)
    },
    edit: (project: LocalProject) => {
      const conn = home.server.focused()

      if (conn) actions.project.edit(conn, project)
    },
    remove: (project: LocalProject) => {
      const conn = home.server.focused()

      if (conn) actions.project.hide(conn, project)
    },
    ready: () => home.server.focusedContext()?.sync.project.ready() ?? false,
  }
}

export type ProjectsController = ReturnType<typeof createProjectsController>
