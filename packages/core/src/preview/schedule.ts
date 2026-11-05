// When to take the next preview thumbnail: a while after something changed, so the page has settled, never two at a
// time, and at most once per interval however often the page changes. Pokes in between fold into one capture.

export function captureSchedule(input: { delay: number; interval: number; run: () => Promise<void> }) {
  const state = {
    timer: undefined as ReturnType<typeof setTimeout> | undefined,
    running: false,
    again: false,
    last: Number.NEGATIVE_INFINITY,
    stopped: false,
  }

  const fire = async () => {
    state.timer = undefined
    state.running = true
    state.last = Date.now()
    // A capture that fails (no Chrome, a page that won't load) leaves the previous thumbnail in place.
    await input.run().catch(() => undefined)
    state.running = false

    if (!state.again) return
    state.again = false
    poke()
  }

  const poke = () => {
    if (state.stopped || state.timer) return

    if (state.running) {
      state.again = true

      return
    }
    const wait = Math.max(input.delay, state.last + input.interval - Date.now())
    state.timer = setTimeout(() => void fire(), wait)
  }

  return {
    /** Something on the page may have changed. */
    poke,
    stop: () => {
      state.stopped = true
      clearTimeout(state.timer)
      state.timer = undefined
    },
  }
}
