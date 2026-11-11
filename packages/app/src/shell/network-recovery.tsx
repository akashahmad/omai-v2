import { onCleanup, onMount } from "solid-js"
import { BrandLoader } from "@/shell/brand-loader"

/** How long a screen waits before it tries again after a request failed in transit. */
const RETRY_MS = 3_000

/**
 * What an error boundary shows for a request that failed in transit, instead of an error: the breathing brand icon,
 * then the screen again a moment later or as soon as the browser is back online. If it fails again, this shows again.
 */
export function NetworkRecovery(props: { reset: () => void }) {
  onMount(() => {
    const retry = () => props.reset()
    const timer = setTimeout(retry, RETRY_MS)

    window.addEventListener("online", retry)
    onCleanup(() => {
      clearTimeout(timer)
      window.removeEventListener("online", retry)
    })
  })

  return <BrandLoader />
}
