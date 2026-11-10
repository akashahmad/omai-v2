import { createSignal } from "solid-js"

// Files attached from outside a composer, such as an image edited in the image preview, go to the composer the user
// is in: the one mounted last.
const targets: ((file: File) => void)[] = []
const [count, setCount] = createSignal(0)

/** Whether a composer is open to take an attachment. */
export const composerOpen = () => count() > 0

/** Attaches a file to the open composer. False when no composer is open. */
export function attachToComposer(file: File) {
  const target = targets.at(-1)

  if (!target) return false
  target(file)

  return true
}

/** Makes a composer the target of `attachToComposer` until the returned function runs. */
export function receiveAttachments(target: (file: File) => void) {
  targets.push(target)
  setCount(targets.length)

  return () => {
    const index = targets.lastIndexOf(target)

    if (index >= 0) targets.splice(index, 1)
    setCount(targets.length)
  }
}
