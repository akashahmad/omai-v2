import { createResource, createSignal, onCleanup } from "solid-js"
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

  // Screenshots of each project's app preview, kept by the server after the preview stops. The list says which
  // projects have one and its hash; a card loads its own image only when it is on screen.
  const [captured] = createResource(
    () => home.server.focused(),
    (conn) =>
      home.server
        .context(conn)
        .sdk.api.experimental.preview.thumbnails()
        .then((items) => new Map(items.map((item) => [item.projectID, item.hash])))
        .catch(() => new Map<string, string>()),
  )

  const images = new Map<string, Promise<string | undefined>>()
  const objectUrls: string[] = []

  onCleanup(() => objectUrls.splice(0).forEach((url) => URL.revokeObjectURL(url)))

  /** The cache key of a project's newest screenshot, or undefined when it has none (or the list is loading). */
  const thumbnailKey = (projectID: string | undefined) => {
    const hashes = captured.state === "ready" || captured.state === "refreshing" ? captured.latest : undefined
    const hash = projectID ? hashes?.get(projectID) : undefined

    return projectID && hash ? `${projectID}:${hash}` : undefined
  }

  /** An object URL for the screenshot `key` names; undefined when it can't be read. */
  const thumbnail = (key: string) => {
    const conn = home.server.focused()
    const cached = images.get(key)

    if (cached || !conn) return cached ?? Promise.resolve(undefined)

    const loading = home.server
      .context(conn)
      .sdk.api.experimental.preview.thumbnail({ projectID: key.slice(0, key.lastIndexOf(":")) })
      .then((bytes) => {
        const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: "image/webp" }))
        objectUrls.push(url)

        return url
      })
      .catch(() => undefined)

    images.set(key, loading)

    return loading
  }

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
    thumbnailKey,
    thumbnail,
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
