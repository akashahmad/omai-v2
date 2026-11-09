import type { ServerConnection } from "@/runtime/server/registry"
import type { Client } from "./client"

export type OpenDeps = {
  client: { projects: Pick<Client["projects"], "open"> }
  /** Adds or updates the project's connection; returns the stored one. */
  addServer: (conn: ServerConnection.Http) => ServerConnection.Http | undefined
  /** Prepares the project folder on its VM (git and the init marker). */
  init: (conn: ServerConnection.Http) => Promise<unknown>
  /** Opens the folder on that connection: its latest session, or a new one. */
  openDirectory: (conn: ServerConnection.Http, directory: string) => Promise<unknown>
}

/**
 * Opens a project: asks the control plane for its address and a VM token, registers a connection for it (one per
 * project, since the URL ends in `/vm/<id>`), prepares the folder, then opens it.
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
  await deps.init(conn)
  await deps.openDirectory(conn, opened.directory)

  return conn
}
