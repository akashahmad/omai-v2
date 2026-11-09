import type { ServerCtx } from "@/runtime/server/runtime"

// Opening a project never waits longer than this to decide on the preview; without an answer it opens chat only.
const LIMIT_MS = 1500

/** Whether the project folder holds anything besides hidden files (`.git` and the like), so there is something to preview. */
export function hasProjectFiles(context: Pick<ServerCtx, "sdk">, directory: string, limitMs = LIMIT_MS) {
  const listed = context.sdk.api.file.list({ location: { directory } }).then(
    // Entries are the folder's direct children, folders with a trailing slash (".git/").
    (result) => result.data.some((entry) => !entry.path.startsWith(".")),
    () => false,
  )

  const timeout = new Promise<boolean>((resolve) => setTimeout(() => resolve(false), limitMs))

  return Promise.race([listed, timeout])
}
