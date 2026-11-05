// What the Checkpoints panel derives from the server's listing: the rows of the tree, how long ago a request was, and
// what the confirm dialog says before a jump.

import type { Checkpoint } from "@opencode/schema/checkpoint"

/** The copy functions the helpers need, as the plugin context provides them. */
export type Words = {
  t: (key: string, params?: Record<string, string | number>) => string
  plural: (key: string, count: number) => string
  locale: string
}

/** One row of the tree: a checkpoint, how deep it is indented, and whether it starts a branch. */
export type Row = { node: Checkpoint.Node; depth: number; split: boolean }

const LISTED = 6

const MS = { minute: 60_000, hour: 3_600_000, day: 86_400_000 }

/**
 * The tree as rows, oldest first: the path the user is on at depth 0, and each stored branch right under the
 * checkpoint it split from, one level deeper. A branch that split before the first checkpoint goes above the trunk.
 */
export function layout(nodes: readonly Checkpoint.Node[]): Row[] {
  const keys = new Set(nodes.map((node) => node.key))
  const branches = nodes.filter((node) => node.path === "branch")
  const placed = new Set<string>()

  // A branch's checkpoints after its first one follow it on the same stored path.
  const chain = (start: Checkpoint.Node): Checkpoint.Node[] => {
    const next = branches.find(
      (node) => node.parentKey === start.key && node.branchID === start.branchID && !placed.has(node.key),
    )

    placed.add(start.key)

    return next ? [start, ...chain(next)] : [start]
  }

  const rows = (path: Checkpoint.Node[], depth: number, split: boolean): Row[] =>
    path.flatMap((node, index) => [
      { node, depth, split: split && index === 0 },
      ...forks(node, path[index + 1]).flatMap((fork) => rows(chain(fork), depth + 1, true)),
    ])

  const forks = (node: Checkpoint.Node, next: Checkpoint.Node | undefined) =>
    branches.filter((item) => item.parentKey === node.key && item !== next && !placed.has(item.key))

  const trunk = nodes.filter((node) => node.path !== "branch")
  trunk.forEach((node) => placed.add(node.key))

  const orphans = branches
    .filter((node) => node.parentKey === undefined || !keys.has(node.parentKey))
    .flatMap((node) => (placed.has(node.key) ? [] : rows(chain(node), 1, true)))

  return [...orphans, ...rows(trunk, 0, false)]
}

/**
 * The timeline's lines for each row: `up`/`down` join the row's dot to the previous/next checkpoint of the same path,
 * and `through` lists the shallower paths whose line passes this row on its way to a later checkpoint. A row that
 * starts a branch has no `up`: an elbow joins it to the path it split from instead.
 */
export type Rail = { up: boolean; down: boolean; through: number[] }

export function rails(rows: readonly Row[]): Rail[] {
  // Whether the path at `depth` has a line below row `index`: to a later checkpoint of its own, or to a branch that
  // hangs off it further down.
  const continues = (index: number, depth: number) => {
    const next = rows.slice(index + 1).find((row) => row.depth <= depth || (row.depth === depth + 1 && row.split))

    if (!next) return false

    if (next.depth === depth + 1) return true

    return next.depth === depth && !next.split
  }

  return rows.map((row, index) => {
    const previous = rows
      .slice(0, index)
      .toReversed()
      .find((item) => item.depth <= row.depth)

    return {
      up: !row.split && previous !== undefined && previous.depth === row.depth,
      down: continues(index, row.depth),
      through: Array.from({ length: row.depth }, (_, depth) => depth).filter((depth) => continues(index, depth)),
    }
  })
}

/**
 * The timeline as the panel lists it, newest first: the rows reversed, each with its lines flipped (`up` and `down`
 * swap) so they still join the same checkpoints. A row that starts a branch then joins the path it split from below.
 */
export function timeline(nodes: readonly Checkpoint.Node[]) {
  const rows = layout(nodes)
  const lines = rails(rows)

  return rows
    .map((row, index) => {
      const rail = lines[index] ?? { up: false, down: false, through: [] }

      return { row, rail: { up: rail.down, down: rail.up, through: rail.through } }
    })
    .toReversed()
}

/** How long ago a request was. `time` is in milliseconds; a month or more shows as a date. */
export function relativeTime(time: number, now: number, words: Words) {
  const elapsed = Math.max(0, now - time)

  if (elapsed < MS.minute) return words.t("checkpoints.time.now")

  if (elapsed < MS.hour) return words.plural("checkpoints.time.minutes", Math.floor(elapsed / MS.minute))

  if (elapsed < MS.day) return words.plural("checkpoints.time.hours", Math.floor(elapsed / MS.hour))

  if (elapsed < 30 * MS.day) return words.plural("checkpoints.time.days", Math.floor(elapsed / MS.day))

  return new Intl.DateTimeFormat(words.locale, { dateStyle: "medium" }).format(time)
}

/**
 * What the confirm dialog says before a jump: the conversation, the files it puts back, and that it can be undone.
 * `overwritten` is undefined when the files could not be listed, which the dialog says instead of guessing.
 */
export function confirmText(target: Checkpoint.Node, overwritten: readonly string[] | undefined, words: Words) {
  const files = !overwritten
    ? words.t("checkpoints.confirm.unknownFiles")
    : overwritten.length === 0
      ? words.t("checkpoints.confirm.noFiles")
      : [
          words.plural("checkpoints.confirm.files", overwritten.length),
          ...overwritten.slice(0, LISTED),
          ...(overwritten.length > LISTED
            ? [words.t("checkpoints.confirm.more", { count: overwritten.length - LISTED })]
            : []),
        ].join("\n")

  return {
    title: words.t("checkpoints.confirm.title"),
    description: [
      words.t("checkpoints.confirm.conversation", { title: target.title || words.t("checkpoints.untitled") }),
      files,
      words.t("checkpoints.confirm.undo"),
    ].join("\n\n"),
    confirm: words.t("checkpoints.confirm.go"),
  }
}

/**
 * Whether a jump refusal still blocks: while the session the server named runs. A session this window has no data for
 * has no status to follow, so its refusal holds until the user's next action.
 */
export function holdsRefusal(session: { known: boolean; running: boolean }) {
  return !session.known || session.running
}

/** The sentence the panel shows for a failed read or action: plain copy for the refusals it knows, else the server's. */
export function failureText(error: { readonly type?: string; readonly message?: string }, words: Words) {
  if (error.type === "checkpoint.missing") return words.t("checkpoints.error.missing")

  if (error.type === "checkpoint.queued") return words.t("checkpoints.error.queued")

  return error.message || words.t("checkpoints.error.failed")
}
