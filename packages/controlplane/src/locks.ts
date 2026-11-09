export * as Locks from "./locks.js"

/**
 * One queue per project for changes to its site and domains on Cloudflare. Removing a site, releasing a name and a
 * domain change each read rows and then write to Cloudflare, so two of them interleaving could leave a hostname or
 * route no row names. Different projects never share keys and run concurrently.
 */
export function make() {
  const tails = new Map<string, Promise<unknown>>()
  return {
    serial: <A>(projectID: string, work: () => Promise<A>) => {
      const next = (tails.get(projectID) ?? Promise.resolve()).then(work, work)
      const settled = next.catch(() => {})
      tails.set(projectID, settled)
      void settled.then(() => {
        if (tails.get(projectID) === settled) tails.delete(projectID)
      })
      return next
    },
  }
}

export type Locks = ReturnType<typeof make>
