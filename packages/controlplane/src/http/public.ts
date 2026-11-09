export * as PublicHttp from "./public.js"

import type { IncomingMessage, ServerResponse } from "node:http"
import { Schema } from "effect"
import type { Auth, Issued } from "../auth.js"
import type { Config } from "../config.js"
import type { Platform } from "../platform.js"
import type { Projects } from "../projects.js"
import { bearer, body, cookies, jsonDecoder, send } from "./http.js"

type Deps = { config: Config; auth: Auth; projects: ReturnType<typeof Projects.make>; platform: Platform }
type Context = {
  req: IncomingMessage
  res: ServerResponse
  params: string[]
  headers: Record<string, string | string[]>
}
type Session = { userID: string; sessionID: string; admin: boolean }

type Route =
  | { method: string; path: RegExp; auth: false; run: (ctx: Context) => Promise<void> }
  | { method: string; path: RegExp; auth: true; run: (ctx: Context, session: Session) => Promise<void> }

const Login = jsonDecoder(Schema.Struct({ login: Schema.String, password: Schema.String }))
const Signup = jsonDecoder(Schema.Struct({ username: Schema.String, email: Schema.String, password: Schema.String }))
const Name = jsonDecoder(Schema.Struct({ name: Schema.String }))
const Models = jsonDecoder(
  Schema.Struct({
    models: Schema.Array(Schema.Struct({ providerID: Schema.String, modelID: Schema.String })).check(
      Schema.isMaxLength(2000),
    ),
  }),
)

/** The browser-facing API on `config.port`. Only the web app's origin may call it with credentials. */
export function make(deps: Deps) {
  const secure = deps.config.appOrigin.startsWith("https:")
  const cookieName = secure ? "__Host-omai_refresh" : "omai_refresh"
  // Host-only (no Domain): the cookie never reaches published apps or previews on sibling hosts.
  const cookie = (value: string, maxAge?: number) =>
    [
      `${cookieName}=${value}`,
      "HttpOnly",
      "SameSite=Lax",
      "Path=/",
      ...(secure ? ["Secure"] : []),
      ...(maxAge !== undefined ? [`Max-Age=${maxAge}`] : []),
    ].join("; ")
  const issued = (ctx: Context, result: Issued) =>
    send(
      ctx.res,
      200,
      { accessToken: result.accessToken, user: result.user },
      { ...ctx.headers, "set-cookie": cookie(result.refreshToken) },
    )

  const projectResult = (ctx: Context, result: unknown, okStatus = 200) => {
    if (result === undefined) return send(ctx.res, 404, { error: "not-found" }, ctx.headers)
    if (result === "exists") return send(ctx.res, 409, { error: "exists" }, ctx.headers)
    if (result === "invalid") return send(ctx.res, 400, { error: "invalid" }, ctx.headers)
    return send(ctx.res, okStatus, result, ctx.headers)
  }

  const routes: Route[] = [
    {
      method: "GET",
      path: /^\/config$/,
      auth: false,
      run: async (ctx) => send(ctx.res, 200, { signupEnabled: deps.config.signupEnabled }, ctx.headers),
    },
    {
      method: "POST",
      path: /^\/auth\/login$/,
      auth: false,
      run: async (ctx) => {
        const input = await body(ctx.req, Login)
        if (!input) return send(ctx.res, 400, { error: "invalid-request" }, ctx.headers)
        const result = await deps.auth.login(input)
        if (result === "invalid") return send(ctx.res, 401, { error: "invalid" }, ctx.headers)
        issued(ctx, result)
      },
    },
    {
      method: "POST",
      path: /^\/auth\/signup$/,
      auth: false,
      run: async (ctx) => {
        // While signup is off the endpoint pretends not to exist.
        if (!deps.config.signupEnabled) return send(ctx.res, 404, { error: "not-found" }, ctx.headers)
        const input = await body(ctx.req, Signup)
        if (!input || !input.username.trim() || !input.email.includes("@") || input.password.length < 8)
          return send(ctx.res, 400, { error: "invalid-request" }, ctx.headers)
        const result = await deps.auth.signup(input)
        if (result === "disabled") return send(ctx.res, 404, { error: "not-found" }, ctx.headers)
        if (result === "exists") return send(ctx.res, 409, { error: "exists" }, ctx.headers)
        issued(ctx, result)
      },
    },
    {
      method: "POST",
      path: /^\/auth\/refresh$/,
      auth: false,
      run: async (ctx) => {
        const token = cookies(ctx.req)[cookieName]
        const result = token ? await deps.auth.refresh(token) : "ended"
        if (result === "ended")
          return send(ctx.res, 401, { error: "unauthenticated" }, { ...ctx.headers, "set-cookie": cookie("", 0) })
        issued(ctx, result)
      },
    },
    {
      method: "POST",
      path: /^\/auth\/ping$/,
      auth: true,
      run: async (ctx) => {
        await deps.auth.ping(bearer(ctx.req)!)
        send(ctx.res, 204, undefined, ctx.headers)
      },
    },
    {
      method: "POST",
      path: /^\/auth\/logout$/,
      auth: true,
      run: async (ctx) => {
        await deps.auth.logout(bearer(ctx.req)!)
        send(ctx.res, 204, undefined, { ...ctx.headers, "set-cookie": cookie("", 0) })
      },
    },
    {
      method: "GET",
      path: /^\/projects$/,
      auth: true,
      run: async (ctx, session) => send(ctx.res, 200, await deps.projects.list(session.userID), ctx.headers),
    },
    {
      method: "POST",
      path: /^\/projects$/,
      auth: true,
      run: async (ctx, session) => {
        const input = await body(ctx.req, Name)
        if (!input) return send(ctx.res, 400, { error: "invalid" }, ctx.headers)
        projectResult(ctx, await deps.projects.create(session.userID, input.name), 201)
      },
    },
    {
      method: "GET",
      path: /^\/projects\/([^/]+)$/,
      auth: true,
      run: async (ctx, session) => projectResult(ctx, await deps.projects.get(session.userID, ctx.params[0]!)),
    },
    {
      method: "PATCH",
      path: /^\/projects\/([^/]+)$/,
      auth: true,
      run: async (ctx, session) => {
        const input = await body(ctx.req, Name)
        if (!input) return send(ctx.res, 400, { error: "invalid" }, ctx.headers)
        projectResult(ctx, await deps.projects.rename(session.userID, ctx.params[0]!, input.name))
      },
    },
    {
      method: "DELETE",
      path: /^\/projects\/([^/]+)$/,
      auth: true,
      run: async (ctx, session) => {
        if (!(await deps.projects.remove(session.userID, ctx.params[0]!)))
          return send(ctx.res, 404, { error: "not-found" }, ctx.headers)
        send(ctx.res, 204, undefined, ctx.headers)
      },
    },
    {
      method: "GET",
      path: /^\/projects\/([^/]+)\/thumbnail$/,
      auth: true,
      run: async (ctx, session) => {
        const found = await deps.projects.thumbnail(session.userID, ctx.params[0]!)
        if (!found) return send(ctx.res, 404, { error: "not-found" }, ctx.headers)
        const etag = `"${found.hash}"`
        const headers = {
          ...ctx.headers,
          etag,
          "cache-control": "private, no-cache",
          "x-content-type-options": "nosniff",
        }
        if (ctx.req.headers["if-none-match"] === etag) return send(ctx.res, 304, undefined, headers)
        ctx.res.writeHead(200, {
          ...headers,
          "content-type": "image/webp",
          "content-length": String(found.data.length),
        })
        ctx.res.end(found.data)
      },
    },
    {
      // The open project's tab is visible and its user interacted lately: keep its VM awake.
      method: "POST",
      path: /^\/projects\/([^/]+)\/presence$/,
      auth: true,
      run: async (ctx, session) => {
        const project = await deps.projects.get(session.userID, ctx.params[0]!)
        if (!project) return send(ctx.res, 404, { error: "not-found" }, ctx.headers)
        await deps.projects.lifecycle.touch(project.id)
        // Someone is using it but it paused (e.g. the tab was hidden): start it again for them.
        if (project.vmState === "paused" || project.vmState === "pausing")
          await deps.projects.wake(session.userID, project.id)
        send(ctx.res, 204, undefined, ctx.headers)
      },
    },
    {
      // Starts a paused VM early (the projects page), so opening it later is quick.
      method: "POST",
      path: /^\/projects\/([^/]+)\/wake$/,
      auth: true,
      run: async (ctx, session) => {
        if (!(await deps.projects.wake(session.userID, ctx.params[0]!)))
          return send(ctx.res, 404, { error: "not-found" }, ctx.headers)
        send(ctx.res, 202, undefined, ctx.headers)
      },
    },
    {
      method: "POST",
      path: /^\/projects\/([^/]+)\/retry$/,
      auth: true,
      run: async (ctx, session) => projectResult(ctx, await deps.projects.retry(session.userID, ctx.params[0]!)),
    },
    {
      method: "POST",
      path: /^\/projects\/([^/]+)\/open$/,
      auth: true,
      run: async (ctx, session) => {
        const result = await deps.projects
          .open(session.userID, session.sessionID, ctx.params[0]!)
          .catch((error: unknown) => {
            console.error("opening project failed", error)
            return "unavailable" as const
          })
        if (result === "not-ready") return send(ctx.res, 409, { error: "not-ready" }, ctx.headers)
        if (result === "unavailable") return send(ctx.res, 503, { error: "unavailable" }, ctx.headers)
        projectResult(ctx, result)
      },
    },
    {
      // Which models are shared with everyone (names only), so the model picker always shows them.
      method: "GET",
      path: /^\/models\/shared$/,
      auth: true,
      run: async (ctx) => send(ctx.res, 200, await deps.platform.models(), ctx.headers),
    },
    // Platform settings: admins only. To everyone else these routes don't exist.
    {
      method: "POST",
      path: /^\/platform\/open$/,
      auth: true,
      run: async (ctx, session) => {
        if (!session.admin) return send(ctx.res, 404, { error: "not-found" }, ctx.headers)
        const opened = await deps.platform.open(session.userID, session.sessionID).catch((error: unknown) => {
          console.error("opening the platform server failed", error)
          return undefined
        })
        if (!opened) return send(ctx.res, 503, { error: "unavailable" }, ctx.headers)
        send(ctx.res, 200, opened, ctx.headers)
      },
    },
    {
      method: "GET",
      path: /^\/platform\/models$/,
      auth: true,
      run: async (ctx, session) => {
        if (!session.admin) return send(ctx.res, 404, { error: "not-found" }, ctx.headers)
        send(ctx.res, 200, await deps.platform.models(), ctx.headers)
      },
    },
    {
      method: "PUT",
      path: /^\/platform\/models$/,
      auth: true,
      run: async (ctx, session) => {
        if (!session.admin) return send(ctx.res, 404, { error: "not-found" }, ctx.headers)
        const input = await body(ctx.req, Models)
        if (!input) return send(ctx.res, 400, { error: "invalid" }, ctx.headers)
        await deps.platform.setModels(input.models)
        send(ctx.res, 204, undefined, ctx.headers)
      },
    },
  ]

  return async function handle(req: IncomingMessage, res: ServerResponse) {
    const origin = req.headers.origin
    const allowed = origin === deps.config.appOrigin
    const headers: Record<string, string> = allowed
      ? {
          "access-control-allow-origin": deps.config.appOrigin,
          "access-control-allow-credentials": "true",
          vary: "Origin",
        }
      : { vary: "Origin" }
    if (req.method === "OPTIONS") {
      if (!allowed) return send(res, 403)
      return send(res, 204, undefined, {
        ...headers,
        "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
        "access-control-allow-headers": "authorization, content-type",
        "access-control-max-age": "86400",
      })
    }
    // Every state-changing request must come from the web app itself.
    if (req.method !== "GET" && req.method !== "HEAD" && !allowed) return send(res, 403, { error: "forbidden" })
    const pathname = new URL(req.url ?? "/", "http://control-plane").pathname
    const matches = routes.flatMap((route) => {
      const match = route.path.exec(pathname)
      return match ? [{ route, params: match.slice(1).map(decodeURIComponent) }] : []
    })
    if (matches.length === 0) return send(res, 404, { error: "not-found" }, headers)
    const found = matches.find((item) => item.route.method === req.method)
    if (!found) return send(res, 405, { error: "method-not-allowed" }, headers)
    const ctx = { req, res, params: found.params, headers }
    if (!found.route.auth) return found.route.run(ctx)
    const token = bearer(req)
    const session = token ? await deps.auth.authenticate(token) : undefined
    if (!session) return send(res, 401, { error: "unauthenticated" }, headers)
    return found.route.run(ctx, session)
  }
}
