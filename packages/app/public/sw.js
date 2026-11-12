// The app no longer uses a service worker. Browsers that installed the old one fetch this file when they check for an
// update: it takes over, deletes the old caches, unregisters itself and reloads open tabs once from the network.
self.addEventListener("install", () => self.skipWaiting())

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      await Promise.all((await caches.keys()).map((key) => caches.delete(key)))
      await self.registration.unregister()
      const tabs = await self.clients.matchAll({ type: "window" })
      await Promise.all(tabs.map((tab) => tab.navigate(tab.url).catch(() => undefined)))
    })(),
  )
})
