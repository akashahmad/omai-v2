// The visual editor's pending changes: what the user changed in the preview and hasn't saved yet. Changes to the same
// element and property merge, so the list shows final values; undo and redo step through what the user did.

import type { LiveChange } from "./protocol"

/** One thing the user did, and the list entry it replaced, so undo can put that entry back. */
type Step = { change: LiveChange; previous?: LiveChange }

export type Pending = { items: LiveChange[]; done: Step[]; undone: Step[] }

const key = (change: LiveChange) => `${change.path}\n${change.kind}\n${change.property ?? ""}`

export const empty = (): Pending => ({ items: [], done: [], undone: [] })

// The list with `change` merged in: the first "before" stays, and an entry back at its original value goes away.
function merge(items: readonly LiveChange[], change: LiveChange) {
  const index = items.findIndex((item) => key(item) === key(change))
  const previous = index === -1 ? undefined : items[index]
  const merged = previous ? { ...change, before: previous.before } : change
  const rest = items.filter((_, position) => position !== index)
  const next = merged.before === merged.after ? rest : index === -1 ? [...items, merged] : items.map((item, position) => (position === index ? merged : item))

  return { next, previous }
}

/** Adds what the user just changed. A new change clears redo. */
export function record(pending: Pending, change: LiveChange): Pending {
  const { next, previous } = merge(pending.items, change)

  return { items: next, done: [...pending.done, { change, previous }], undone: [] }
}

/** What the page must revert to its original, and what it must set again, after an undo or a redo. */
export type PageUpdate = { pending: Pending; revert: LiveChange[]; apply: LiveChange[] }

/** Takes back the last change: what the page must revert to its original, and what it must set again. */
export function undo(pending: Pending): PageUpdate {
  const step = pending.done.at(-1)

  if (!step) return { pending, revert: [], apply: [] }
  const without = pending.items.filter((item) => key(item) !== key(step.change))
  const items = step.previous ? [...without, step.previous] : without

  return {
    pending: { items, done: pending.done.slice(0, -1), undone: [...pending.undone, step] },
    revert: step.previous ? [] : [step.change],
    apply: step.previous ? [step.previous] : [],
  }
}

/** Does the last undone change again. */
export function redo(pending: Pending): PageUpdate {
  const step = pending.undone.at(-1)

  if (!step) return { pending, revert: [], apply: [] }

  return {
    revert: [],
    pending: { items: merge(pending.items, step.change).next, done: [...pending.done, step], undone: pending.undone.slice(0, -1) },
    apply: [step.change],
  }
}

/** Drops one entry of the list; the page reverts it. History is cleared, since its steps no longer line up. */
export function remove(pending: Pending, index: number) {
  const change = pending.items[index]

  return {
    pending: { items: pending.items.filter((_, position) => position !== index), done: [], undone: [] },
    revert: change,
  }
}

/** The list by element, in the order the elements were first changed. */
export function grouped(items: readonly LiveChange[]) {
  const groups = new Map<string, LiveChange[]>()
  items.forEach((item) => groups.set(item.path, [...(groups.get(item.path) ?? []), item]))

  return [...groups.entries()].map(([path, changes]) => ({ path, changes }))
}
