import { parseValue, resolveScript } from "../routing.js"

type Env = {
  DISPATCHER: { get(name: string): { fetch(r: Request): Promise<Response> } }
  HOSTNAMES: { get(k: string): Promise<string | null> }
  ZONE: string
}

export async function dispatch(request: Request, env: Env) {
  const url = new URL(request.url)
  if (url.protocol === "http:") {
    url.protocol = "https:"
    return Response.redirect(url.toString(), 301)
  }
  const host = url.hostname.toLowerCase()
  const raw = await env.HOSTNAMES.get(host)
  const route = raw ? parseValue(raw) : undefined
  if (route && "redirect" in route) return Response.redirect(`https://${route.redirect}${url.pathname}${url.search}`, 301)
  const script = route?.script ?? resolveScript(host, env.ZONE)
  if (!script) return notFound()
  // `get` may throw synchronously, so it runs inside the same promise chain as `fetch`.
  return Promise.resolve()
    .then(() => env.DISPATCHER.get(script).fetch(request))
    .catch((e: unknown) => {
      if (e instanceof Error && /worker not found|worker has been deleted/i.test(e.message)) return notFound()
      throw e
    })
}

function notFound() {
  return new Response("Not found", { status: 404 })
}

export default { fetch: dispatch }
