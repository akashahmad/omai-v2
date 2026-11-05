// The page the preview shows while the dev server is not answering yet. It reloads itself once the app is up: on a
// `reload` event from the proxy, or when polling finds a real page.

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
<script>
  const reload = () => location.reload()
  new EventSource("/__omai/events").addEventListener("reload", reload)
  setInterval(async () => {
    const res = await fetch(location.href, { headers: { accept: "text/html" } }).catch(() => undefined)
    if (res && !res.headers.get("x-omai-starting")) reload()
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
