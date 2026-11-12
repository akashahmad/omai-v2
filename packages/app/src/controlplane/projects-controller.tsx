import { useDialog } from "@opencode/ui/context/dialog"
import { Dialog, DialogBody, DialogHeader, DialogTitleGroup } from "@opencode/ui/dialog"
import { Icon } from "@opencode/ui/icon"
import { Loader } from "@opencode/ui/loader"
import { Option, Schema } from "effect"
import { createMemo, createResource, createSignal, onCleanup, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { createHomeController } from "@/home/model"
import { addProjects } from "@/home/projects/add"
import { checkProjectFiles } from "@/home/projects/has-files"
import { useLanguage } from "@/runtime/i18n/language"
import { ServerConnection, useServers } from "@/runtime/server/registry"
import { useSettingsSurface } from "@/settings/surface"
import { projectOfConnection } from "./presence"
import { useGlobal } from "@/runtime/server/runtime"
import { errorMessage } from "@/shell/layout/helpers"
import { showToast } from "@/shell/notifications/toast"
import type { LocalProject } from "@/shell/state/layout"
import type { Client, ProjectView } from "./client"
import { openProject } from "./open"
import { useControlPlane } from "./session"

/**
 * The projects pages' controller in multi-user mode: the same shape as the local one, so Home and All projects look
 * exactly the same, but the list comes from the control plane and opening a project connects to its VM.
 */
export function createControlPlaneProjectsController() {
  const session = useControlPlane()
  const language = useLanguage()
  const servers = useServers()
  const settings = useSettingsSurface()
  const global = useGlobal()
  const home = createHomeController()
  const dialog = useDialog()
  const [opening, setOpening] = createSignal<string>()
  const [projects, { refetch }] = createResource(() => session.client.projects.list())

  const loaded = () => projects.state === "ready" || projects.state === "refreshing"

  // A project still starting updates on its own, and a list that failed to load (a dropped connection) is asked for
  // again. `latest` throws once the list failed, so it is only read while loaded.
  const timer = setInterval(() => {
    if (projects.state === "errored") return void refetch()

    if (loaded() && projects.latest?.some((project) => project.vmState === "creating")) void refetch()
  }, 2000)

  onCleanup(() => clearInterval(timer))
  const byID = createMemo(() => new Map((loaded() ? projects.latest : undefined)?.map((item) => [item.id, item]) ?? []))
  const list = createMemo(() => [...byID().values()].map(toLocal))

  const images = new Map<string, Promise<string | undefined>>()
  const objectUrls: string[] = []
  onCleanup(() => objectUrls.splice(0).forEach((url) => URL.revokeObjectURL(url)))

  /** An object URL for the screenshot `key` names; undefined when it can't be read. */
  function thumbnail(key: string) {
    const cached = images.get(key)

    if (cached) return cached
    const loading = session.client.projects
      .thumbnail(key.slice(0, key.lastIndexOf(":")))
      .then((blob) => {
        if (!blob) return undefined
        const url = URL.createObjectURL(blob)
        objectUrls.push(url)

        return url
      })
      .catch(() => undefined)
    images.set(key, loading)

    return loading
  }

  async function open(project: LocalProject) {
    const found = project.id ? byID().get(project.id) : undefined

    if (found) await openView(found)
  }

  // Takes the project itself, not its list entry: a project just created can open before the list shows it.
  async function openView(found: ProjectView) {
    if (opening()) return
    setOpening(toLocal(found).worktree)
    warmRouter()
    await untilRunning(session.client, found)
      .then(() =>
        openProject(found, {
          client: session.client,
          addServer: (conn) => servers.add(conn),
          init: (conn) => global.ensureServerCtx(conn).sdk.api.experimental["project-vm"].init(),
          // Same as opening a local project: its latest session, or a new one. Each call is a round trip to the VM,
          // so the lookups run while the folder is prepared; only creating a session waits for it.
          openDirectory: async (conn, directory, ready) => {
            const ctx = global.ensureServerCtx(conn)
            // A folder still being prepared fails the listing, which asks again, so this adds no wait either.
            const preview = checkProjectFiles(ctx, directory)

            const [page] = await Promise.all([
              ctx.sdk.api.session.list({ directory, parentID: null, archived: false, order: "desc", limit: 1 }),
              ready,
            ])

            const added = addProjects(ctx, [directory])

            const latest =
              page.data[0] ??
              (await ctx.data.session.create({ location: { directory }, projectID: (await added)?.id }).request)

            home.project.openProjectSession(conn, directory, latest, {
              preview: await preview.now,
              later: preview.later,
            })
            // Lists the project in the app; opening doesn't wait for it.
            await added
          },
        }),
      )
      .then((result) => {
        if (result === "not-ready") showToast({ title: language.t("cp.projects.starting") })
      })
      .catch((cause: unknown) =>
        showToast({
          title: language.t("common.requestFailed"),
          description: errorMessage(cause, language.t("common.requestFailed")),
        }),
      )
      .finally(() => setOpening(undefined))
  }

  // The connection to the router (TLS) is made while the control plane answers, instead of after it. Its address is
  // known once any project was opened in this browser.
  function warmRouter() {
    const known = servers.list.find((conn) => conn.type === "http" && projectOfConnection(conn.http.url))
    const origin = known?.type === "http" ? new URL(known.http.url).origin : undefined

    if (!origin) return
    // A browser drops an unused warm connection after a few seconds and warms only when the link is added.
    document.head.querySelector(`link[rel="preconnect"][href="${origin}"]`)?.remove()
    const link = document.createElement("link")
    link.rel = "preconnect"
    link.href = origin
    // The app calls the router without cookies, so the warmed connection must be the anonymous one.
    link.crossOrigin = "anonymous"
    document.head.append(link)
  }

  return {
    language,
    list,
    opening,
    // The control plane keeps each project's latest preview screenshot; the key changes with every new capture.
    thumbnailKey: (projectID: string | undefined): string | undefined => {
      const hash = projectID ? byID().get(projectID)?.thumbnail : undefined

      return projectID && hash ? `${projectID}:${hash}` : undefined
    },
    thumbnail,
    open,
    create: () =>
      void dialog.show(() => (
        <CreateProjectDialog
          client={session.client}
          onCreated={() => void refetch()}
          onReady={(created) => void openView(created)}
        />
      )),
    // Edit opens the project's settings, as for a local project. They live on its VM, so a project this browser has
    // not opened yet is opened first (which starts a paused VM); its settings show once it answers.
    edit: (project: LocalProject) => {
      const found = project.id ? byID().get(project.id) : undefined

      if (!found) return
      const known = servers.list.find((conn) => conn.type === "http" && projectOfConnection(conn.http.url) === found.id)

      if (known) return settings.openProject({ server: ServerConnection.key(known), project: toLocal(found).worktree })
      void session.client.projects
        .open(found.id)
        .then((opened) => {
          if (opened === "not-ready") {
            showToast({ title: language.t("cp.projects.starting") })

            return
          }

          const conn = servers.add({
            type: "http",
            http: { url: opened.routerUrl, password: opened.token },
            displayName: found.name,
          })

          if (conn) settings.openProject({ server: ServerConnection.key(conn), project: opened.directory })
        })
        .catch((cause: unknown) =>
          showToast({
            title: language.t("common.requestFailed"),
            description: errorMessage(cause, language.t("common.requestFailed")),
          }),
        )
    },
    remove: (project: LocalProject) => {
      if (!project.id) return
      void session.client.projects.remove(project.id).then(() => refetch())
    },
    ready: loaded,
  }
}

function toLocal(project: ProjectView): LocalProject {
  return { id: project.id, name: project.name, worktree: `/home/omai/${project.slug}` }
}

/** Waits for the project's VM; a failed one is started again once. */
async function untilRunning(client: Client, project: ProjectView) {
  const retried = { done: false }

  for (let current = project; ; ) {
    // A paused VM is started by opening it.
    if (current.vmState !== "creating" && current.vmState !== "failed") return current

    if (current.vmState === "failed" && retried.done) throw new Error(current.vmError ?? "The project could not start")

    if (current.vmState === "failed") {
      retried.done = true
      current = await client.projects.retry(current.id)
      continue
    }

    await new Promise((resolve) => setTimeout(resolve, 1000))
    current = await client.projects.get(current.id)
  }
}

const UPLOAD_LIMIT = 500 * 1024 * 1024

// The field look the app's other O M A I + dialogs use (the visual editor's image dialog).
const FIELD =
  "relative flex h-9 w-full min-w-0 items-center rounded-lg bg-v2-overlay-simple-overlay-hover transition-[background-color,box-shadow] duration-150 hover:shadow-[inset_0_0_0_1px_var(--v2-border-border-base)] focus-within:bg-v2-background-bg-base focus-within:shadow-[inset_0_0_0_1px_#1a64d6,0_0_0_3px_rgb(26_100_214/0.14)]"

const PRIMARY =
  "inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-lg bg-[#0a3a78] px-4 text-12-medium text-[#fff] hover:bg-[#082f62] disabled:cursor-default disabled:opacity-50"

const SECONDARY =
  "h-8 cursor-pointer rounded-lg px-3.5 text-12-medium text-v2-text-text-base hover:bg-v2-overlay-simple-overlay-hover disabled:cursor-default disabled:opacity-50"

/** Name and an optional zip. Waits for the VM, uploads the zip through the router, then opens the project. */
function CreateProjectDialog(props: {
  client: Client
  onCreated: () => void
  onReady: (project: ProjectView) => void
}) {
  const dialog = useDialog()
  const language = useLanguage()
  const [state, setState] = createStore({
    name: "",
    zip: undefined as File | undefined,
    over: false,
    busy: undefined as "starting" | "uploading" | undefined,
    percent: 0,
    error: undefined as string | undefined,
    // Kept after a failed start, so trying again starts the same project instead of clashing with its name.
    project: undefined as ProjectView | undefined,
  })
  let picker: HTMLInputElement | undefined

  const choose = (file: File | undefined) => {
    if (!file) return

    if (!file.name.toLowerCase().endsWith(".zip")) return setState("error", language.t("cp.create.notZip"))

    if (file.size > UPLOAD_LIMIT) return setState("error", language.t("cp.create.tooLarge"))
    setState({ zip: file, error: undefined })
  }

  const submit = async (event: SubmitEvent) => {
    event.preventDefault()

    if (state.busy || !state.name.trim()) return
    setState({ error: undefined, busy: "starting" })
    const created =
      state.project ??
      (await props.client.projects
        .create(state.name)
        .catch((cause: unknown) => new Error(errorMessage(cause, language.t("common.requestFailed")))))

    if (created === "exists") return setState({ busy: undefined, error: language.t("cp.create.exists") })

    if (created === "invalid") return setState({ busy: undefined, error: language.t("cp.create.invalid") })

    if (created instanceof Error) return setState({ busy: undefined, error: created.message })
    if (!state.project) props.onCreated()
    setState("project", created)
    const ready = await untilRunning(props.client, created).catch(
      (cause: unknown) => new Error(errorMessage(cause, language.t("common.requestFailed"))),
    )

    if (ready instanceof Error) return setState({ busy: undefined, error: ready.message })

    if (state.zip) {
      setState({ busy: "uploading", percent: 0 })
      const opened = await props.client.projects.open(created.id)
      const uploaded =
        opened === "not-ready"
          ? "not-ready"
          : await upload(opened, state.zip, (percent) => setState("percent", percent))

      if (uploaded !== true)
        return setState({ busy: undefined, error: language.t("cp.create.uploadFailed", { reason: uploaded }) })
    }

    dialog.close()
    props.onReady(created)
  }

  return (
    <Dialog class="w-[480px]" fit>
      <DialogHeader>
        <DialogTitleGroup title={language.t("projects.new")} />
      </DialogHeader>
      <DialogBody>
        <form class="flex flex-col gap-4 px-5 pb-5" onSubmit={(event) => void submit(event)}>
          <label class="flex flex-col gap-1.5">
            <span class="text-[11px] text-v2-text-text-muted">{language.t("cp.create.name")}</span>
            <span class={FIELD}>
              <input
                autofocus
                maxLength={64}
                class="h-9 min-w-0 flex-1 bg-transparent px-3 text-[13px] text-v2-text-text-base outline-none placeholder:text-v2-text-text-faint"
                placeholder={language.t("cp.create.namePlaceholder")}
                value={state.name}
                disabled={!!state.busy || !!state.project}
                onInput={(event) => setState("name", event.currentTarget.value)}
              />
            </span>
          </label>

          <div class="flex flex-col gap-1.5">
            <span class="text-[11px] text-v2-text-text-muted">{language.t("cp.create.zip")}</span>
            <button
              type="button"
              data-action="project-create-zip"
              disabled={!!state.busy}
              class="group relative flex min-h-36 cursor-pointer flex-col items-center justify-center gap-2 overflow-hidden rounded-xl border border-dashed px-6 py-6 text-center transition-colors disabled:cursor-default"
              classList={{
                "border-[#1a64d6] bg-[#1a64d6]/[0.08]": state.over,
                "border-v2-border-border-strong hover:border-[#1a64d6]/60 hover:bg-[#1a64d6]/[0.04]": !state.over,
              }}
              onClick={() => picker?.click()}
              onDragOver={(event) => {
                event.preventDefault()
                setState("over", true)
              }}
              onDragLeave={() => setState("over", false)}
              onDrop={(event) => {
                event.preventDefault()
                setState("over", false)
                choose(event.dataTransfer?.files[0])
              }}
            >
              <Show
                when={state.zip}
                fallback={
                  <>
                    <span
                      class="flex size-11 items-center justify-center rounded-full transition-colors"
                      classList={{
                        "bg-[#1a64d6]/15 text-[#1a64d6]": state.over,
                        "bg-v2-overlay-simple-overlay-hover text-v2-text-text-muted group-hover:text-[#1a64d6]":
                          !state.over,
                      }}
                    >
                      <Icon name="cloud-upload" />
                    </span>
                    <span class="text-[13px] font-[500] text-v2-text-text-base">
                      {language.t("cp.create.dropTitle")}
                    </span>
                    <span class="-mt-1 max-w-[360px] text-[12px] leading-[18px] text-v2-text-text-muted">
                      {language.t("cp.create.dropBody")}
                    </span>
                    <span class="text-[11px] text-v2-text-text-faint">{language.t("cp.create.formats")}</span>
                  </>
                }
              >
                {(zip) => (
                  <>
                    <span class="flex size-11 items-center justify-center rounded-full bg-[#1a64d6]/15 text-[#1a64d6]">
                      <Icon name="folder" />
                    </span>
                    <span class="max-w-full truncate text-[13px] font-[500] text-v2-text-text-base">{zip().name}</span>
                    <span class="-mt-1 text-[12px] text-v2-text-text-muted">
                      {fileSize(zip().size)} · {language.t("cp.create.change")}
                    </span>
                  </>
                )}
              </Show>
            </button>
            <input
              ref={picker}
              type="file"
              accept=".zip,application/zip"
              class="hidden"
              onChange={(event) => {
                choose(event.currentTarget.files?.[0])
                event.currentTarget.value = ""
              }}
            />
            <Show when={state.zip && !state.busy}>
              <button
                type="button"
                class="self-start cursor-pointer text-[11.5px] text-v2-text-text-muted hover:text-v2-text-text-base"
                onClick={() => setState("zip", undefined)}
              >
                {language.t("cp.create.removeZip")}
              </button>
            </Show>
          </div>

          <Show when={state.busy}>
            {(busy) => (
              <div class="flex flex-col gap-2" role="status" aria-live="polite">
                <span class="text-[12px] text-v2-text-text-muted">
                  {busy() === "uploading"
                    ? language.t("cp.create.uploading", { percent: state.percent })
                    : language.t("cp.create.starting")}
                </span>
                <span class="h-1 w-full overflow-hidden rounded-full bg-v2-overlay-simple-overlay-hover">
                  <span
                    class="block h-full rounded-full bg-[#0a3a78] transition-[width] duration-300"
                    style={{ width: busy() === "uploading" ? `${state.percent}%` : "35%" }}
                  />
                </span>
              </div>
            )}
          </Show>

          <Show when={state.error}>
            {(text) => (
              <p
                role="alert"
                class="flex items-start gap-2 rounded-lg bg-v2-state-bg-danger p-2.5 text-[12px] text-v2-state-fg-danger"
              >
                <Icon name="circle-exclamation" size="small" class="mt-px shrink-0" />
                {text()}
              </p>
            )}
          </Show>

          <div class="flex justify-end gap-2 pt-1">
            <button type="button" class={SECONDARY} onClick={() => dialog.close()}>
              {language.t("common.cancel")}
            </button>
            <button
              type="submit"
              data-action="project-create-submit"
              class={PRIMARY}
              disabled={!!state.busy || !state.name.trim()}
            >
              <Show when={state.busy}>
                <Loader width={14} height={14} style={{ color: "inherit" }} />
              </Show>
              {language.t("cp.create.submit")}
            </button>
          </div>
        </form>
      </DialogBody>
    </Dialog>
  )
}

const fileSize = (bytes: number) =>
  bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`

const decodeMessage = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Struct({ message: Schema.String })))

/** Uploads the zip through the router with progress (fetch cannot report upload progress). True on success. */
function upload(opened: { routerUrl: string; token: string }, zip: File, progress: (percent: number) => void) {
  return new Promise<true | string>((resolve) => {
    const request = new XMLHttpRequest()
    request.open("POST", `${opened.routerUrl}/api/experimental/project-vm/upload`)
    request.setRequestHeader("authorization", `Basic ${btoa(`omai:${opened.token}`)}`)
    request.setRequestHeader("content-type", "application/zip")
    request.upload.onprogress = (event) => {
      if (event.lengthComputable) progress(Math.round((event.loaded / event.total) * 100))
    }

    request.onload = () => {
      if (request.status === 200) return resolve(true)
      // The server explains a rejected zip in `message`.
      resolve(Option.getOrUndefined(decodeMessage(request.responseText))?.message ?? `HTTP ${request.status}`)
    }

    request.onerror = () => resolve("network error")
    request.send(zip)
  })
}
