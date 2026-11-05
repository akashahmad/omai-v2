// A file's change, drawn by the same diff viewer the Review panel uses.

import { createResource, Match, Switch } from "solid-js"
import { usePlugin } from "@opencode/plugin/gui"
import type { GitTool } from "@opencode/schema/git-tool"
import { resolveFileDiff } from "@opencode/session-ui/session-diff"
import { SessionReviewFilePreviewV2 } from "@opencode/session-ui/v2/session-review-file-preview-v2"
import { Note, Spinner } from "../ui"
import type { GitView } from "./view"

export function FileDiff(props: { view: GitView; file: GitTool.FileChange; staged?: boolean; commit?: string }) {
  const ctx = usePlugin()

  // Loads again when the file's change does, so staging a part or editing the file redraws it; the last diff stays on
  // screen meanwhile.
  const [diff] = createResource(
    () => ({
      file: props.file,
      staged: props.staged,
      commit: props.commit,
      key: `${props.file.path}\u0000${props.staged}\u0000${props.commit}\u0000${props.file.additions}\u0000${props.file.deletions}`,
    }),
    (source) => props.view.diff(source.file, { staged: source.staged, commit: source.commit }),
  )

  const status = () => {
    if (props.file.state === "added" || props.file.state === "untracked") return "added"

    return props.file.state === "deleted" ? "deleted" : "modified"
  }

  // The viewer shows a "binary" placeholder when both counts are 0, and the status counts are 0 for a rename or an empty
  // file, so the counts come from the loaded contents. Equal contents get a plain sentence instead of the viewer.
  const counts = (loaded: { before: string; after: string }) =>
    resolveFileDiff({ file: props.file.path, before: loaded.before, after: loaded.after }).hunks.reduce(
      (total, hunk) => ({
        additions: total.additions + hunk.additionLines,
        deletions: total.deletions + hunk.deletionLines,
      }),
      { additions: 0, deletions: 0 },
    )

  const unchanged = (loaded: { after: string }) => {
    if (props.file.state === "renamed") return ctx.t("git.diff.renamed")

    return loaded.after === "" ? ctx.t("git.diff.empty") : ctx.t("git.diff.unchanged")
  }

  return (
    <div data-slot="git-diff" class="rounded-lg border border-v2-border-border-base overflow-hidden">
      <Switch>
        <Match when={diff.state === "errored"}>
          <div class="p-3">
            <Note tone="danger" icon="warning">
              {ctx.t("git.diff.failed")}
            </Note>
          </div>
        </Match>
        <Match when={(diff.state === "ready" || diff.state === "refreshing") && diff.latest}>
          {(loaded) => (
            <Switch>
              <Match when={loaded().binary}>
                <div class="flex items-center justify-center px-4 py-8 text-12-regular text-v2-text-text-muted">
                  {ctx.t("git.diff.binary")}
                </div>
              </Match>
              <Match when={loaded().before === loaded().after}>
                <div class="flex items-center justify-center px-4 py-8 text-center text-12-regular text-v2-text-text-muted">
                  {unchanged(loaded())}
                </div>
              </Match>
              <Match when={!loaded().binary}>
                <div class="h-[420px]">
                  <div data-component="session-review-v2">
                    <SessionReviewFilePreviewV2
                      file={props.file.path}
                      diffStyle="unified"
                      diff={{
                        file: props.file.path,
                        before: loaded().before,
                        after: loaded().after,
                        ...counts(loaded()),
                        status: status(),
                      }}
                    />
                  </div>
                </div>
              </Match>
            </Switch>
          )}
        </Match>
        <Match when={diff.loading}>
          <div class="flex items-center justify-center py-10 text-v2-text-text-muted">
            <Spinner large />
          </div>
        </Match>
      </Switch>
    </div>
  )
}
