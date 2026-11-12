import type { ServerConnection } from "@/runtime/server/registry"
import type { Client } from "./client"

export type OpenDeps = {
  client: { projects: Pick<Client["projects"], "open"> }
  /** Adds or updates the project's connection; returns the stored one. */
  addServer: (conn: ServerConnection.Http) => ServerConnection.Http | undefined
  /** Prepares the project folder on its VM (git and the init marker). */
  init: (conn: ServerConnection.Http) => Promise<unknown>
  /**
   * Opens the folder on that connection: its latest session, or a new one. `ready` settles once the folder is
   * prepared; whatever needs the folder waits for it.
   */
  openDirectory: (conn: ServerConnection.Http, directory: string, ready: Promise<unknown>) => Promise<unknown>
}

/**
 * Opens a project: asks the control plane for its address and a VM token, registers a connection for it (one per
 * project, since the URL ends in `/vm/<id>`), then opens the folder while it is prepared: every call is a round trip
 * to the VM, so the session lookup does not wait for the preparation.
 */
export async function openProject(project: { id: string; name: string }, deps: OpenDeps) {
  const opened = await deps.client.projects.open(project.id)

  if (opened === "not-ready") return "not-ready" as const

  const conn = deps.addServer({
    type: "http",
    http: { url: opened.routerUrl, password: opened.token },
    displayName: project.name,
  })

  if (!conn) throw new Error(`Invalid project address: ${opened.routerUrl}`)
  await deps.openDirectory(conn, opened.directory, deps.init(conn))

  return conn
}
