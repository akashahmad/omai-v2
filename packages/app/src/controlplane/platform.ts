import { projectOfConnection } from "./presence"

/** The platform server's reserved project ID (see the control plane's `Platform.PROJECT_ID`). */
export const PLATFORM_PROJECT = "platform"

/** Whether a connection is the platform server's, which only an admin's Settings > Providers and Models use. */
export function isPlatformConnection(url: string) {
  return projectOfConnection(url) === PLATFORM_PROJECT
}
