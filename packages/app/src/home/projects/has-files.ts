import type { ServerCtx } from "@/runtime/server/runtime"

// Opening a project never waits longer than this to decide on the preview; without an answer it opens chat only.
const LIMIT_MS = 1500

// A VM that is still waking can't list yet; the final answer asks a few times before it settles on "no files".
const ATTEMPTS = 4

const RETRY_MS = 2000

/** Whether the project folder holds anything besides hidden files (`.git` and the like), so there is something to preview. */
export function hasProjectFiles(context: Pick<ServerCtx, "sdk">, directory: string, limitMs = LIMIT_MS) {
  return checkProjectFiles(context, directory, limitMs).now
}

/**
 * The answer for opening a project, `now` within `limitMs`, and `later`, the one the listing settles on. Opening
 * decides with `now` and opens the preview afterwards if `later` finds files that `now` was too early to see.
 */
export function checkProjectFiles(context: Pick<ServerCtx, "sdk">, directory: string, limitMs = LIMIT_MS) {
  const later = list(context, directory, 1)
  const timeout = new Promise<boolean>((resolve) => setTimeout(() => resolve(false), limitMs))

  return { now: Promise.race([later, timeout]), later }
}

function list(context: Pick<ServerCtx, "sdk">, directory: string, attempt: number): Promise<boolean> {
  return context.sdk.api.file.list({ location: { directory } }).then(
    // Entries are the folder's direct children, folders with a trailing slash (".git/").
    (result) => result.data.some((entry) => !entry.path.startsWith(".")),
    () =>
      attempt >= ATTEMPTS
        ? false
        : new Promise<boolean>((resolve) => setTimeout(resolve, RETRY_MS)).then(() =>
            list(context, directory, attempt + 1),
          ),
  )
}
