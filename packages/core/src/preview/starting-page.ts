// The page the preview shows while the dev server is not answering yet. It reloads itself once the app is up: on a
// `reload` event from the proxy, or when the proxy's health says so. It never reloads on any other answer: while a VM
// pauses or boots, the load balancer in front of it answers with its own error page, which would stay on screen.

export const startingPage = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Starting…</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; height: 100vh; display: grid; place-items: center; }
  img { width: 64px; height: 64px; border-radius: 14px; opacity: .3; animation: pulse 2s infinite cubic-bezier(.4, 0, .6, 1); }
  @keyframes pulse { 50% { opacity: .12; } }
  @media (prefers-reduced-motion: reduce) { img { animation: none; } }
</style>
</head>
<body>
<img src="/__omai/logo" alt="">
<script src="/__omai/bridge.js"></script>
<script>
  const reload = () => location.reload()
  new EventSource("/__omai/events").addEventListener("reload", reload)
  setInterval(async () => {
    const health = await fetch("/__omai/health", { cache: "no-store" }).then((res) => res.json()).catch(() => undefined)
    if (health && health.preview === "omai" && health.up) reload()
  }, 2000)
</script>
</body>
</html>
`

/**
 * What the preview shows when there is no page to show: the brand icon, centred, and nothing else. The proxy serves
 * the icon from the app that entered the preview.
 */
export const emptyPage = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title></title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; height: 100vh; display: grid; place-items: center; }
  img { width: 56px; height: 56px; border-radius: 12px; }
</style>
</head>
<body><img src="/__omai/logo" alt=""></body>
</html>
`
