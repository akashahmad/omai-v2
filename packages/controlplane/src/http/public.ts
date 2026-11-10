export * as PublicHttp from "./public.js"

import type { IncomingMessage, ServerResponse } from "node:http"
import { Schema } from "effect"
import type { Auth, Issued } from "../auth.js"
import type { Config } from "../config.js"
import type { Db } from "../db/database.js"
import type { Platform } from "../platform.js"
import type { Projects } from "../projects.js"
import type { Shares } from "../shares.js"
import type { UserModels } from "../user-models.js"
import { Users } from "../users.js"
import { bearer, body, bytes, cookies, jsonDecoder, send } from "./http.js"

type Deps = {
  config: Config
  db: Db
  auth: Auth
  projects: ReturnType<typeof Projects.make>
  platform: Platform
  models: ReturnType<typeof UserModels.make>
  shares: Shares
  /** The providers the platform server shares, each with its switched-on models; undefined when it can't say. */
  shared: () => Promise<readonly { id: string; models: readonly string[] }[] | undefined>
}
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
const ModelSwitch = jsonDecoder(
  Schema.Struct({
    providerID: Schema.String.check(Schema.isMaxLength(200)),
    modelID: Schema.String.check(Schema.isMaxLength(200)),
    visible: Schema.Boolean,
  }),
)
const Models = jsonDecoder(
  Schema.Struct({
    models: Schema.Array(Schema.Struct({ providerID: Schema.String, modelID: Schema.String })).check(
      Schema.isMaxLength(2000),
    ),
  }),
)

const ModelKey = Schema.Struct({
  providerID: Schema.String.check(Schema.isMaxLength(200)),
  modelID: Schema.String.check(Schema.isMaxLength(200)),
})
// The parts of the app hidden from a user: plugin and settings page ids, which the app defines.
const Hidden = Schema.Array(Schema.String.check(Schema.isMaxLength(64))).check(Schema.isMaxLength(64))
const CreateUser = jsonDecoder(
  Schema.Struct({
    username: Schema.String,
    email: Schema.String,
    password: Schema.String,
    admin: Schema.optional(Schema.Boolean),
    hidden: Schema.optional(Hidden),
    model: Schema.optional(Schema.NullOr(ModelKey)),
  }),
)
const UpdateUser = jsonDecoder(
  Schema.Struct({
    admin: Schema.optional(Schema.Boolean),
    hidden: Schema.optional(Hidden),
    model: Schema.optional(Schema.NullOr(ModelKey)),
    password: Schema.optional(Schema.String),
  }),
)
const Share = jsonDecoder(
  Schema.Struct({
    title: Schema.String.check(Schema.isMaxLength(500)),
    data: Schema.Struct({ session: Schema.Unknown, messages: Schema.Array(Schema.Unknown) }),
  }),
)

// The same rules the admin's Add user form shows.
const USERNAME = /^[a-zA-Z0-9][a-zA-Z0-9_-]{2,29}$/
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const PASSWORD_MIN = 12
// A shared conversation carries its pasted images inline, so its copy may be large.
const SHARE_LIMIT = 25 * 1024 * 1024

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
        // A user becoming active gets their reserve VMs booting now, before they create a project.
        void deps.projects.reserves.refill()
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
        void deps.projects.reserves.refill()
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
        // The app pings at most once a minute while the user clicks, types or moves the pointer.
        if (await deps.auth.ping(bearer(ctx.req)!)) void deps.projects.reserves.refill()
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
      run: async (ctx) => send(ctx.res, 200, await usableShared(), ctx.headers),
    },
    {
      // The signed-in user's own model switches, the same in all their projects.
      method: "GET",
      path: /^\/models\/mine$/,
      auth: true,
      run: async (ctx, session) => send(ctx.res, 200, await deps.models.list(session.userID), ctx.headers),
    },
    {
      method: "PUT",
      path: /^\/models\/mine$/,
      auth: true,
      run: async (ctx, session) => {
        const input = await body(ctx.req, ModelSwitch)
        if (!input) return send(ctx.res, 400, { error: "invalid" }, ctx.headers)
        await deps.models.set(session.userID, input)
        send(ctx.res, 204, undefined, ctx.headers)
      },
    },
    // Sharing a conversation by a public link: its owner sends a copy; anyone with the link reads it.
    {
      method: "GET",
      path: /^\/projects\/([^/]+)\/shares\/([^/]+)$/,
      auth: true,
      run: async (ctx, session) => {
        const found = await deps.shares.find(session.userID, ctx.params[0]!, ctx.params[1]!)
        if (!found) return send(ctx.res, 404, { error: "not-found" }, ctx.headers)
        send(ctx.res, 200, found, ctx.headers)
      },
    },
    {
      method: "PUT",
      path: /^\/projects\/([^/]+)\/shares\/([^/]+)$/,
      auth: true,
      run: async (ctx, session) => {
        const raw = await bytes(ctx.req, SHARE_LIMIT)
        if (!raw) return send(ctx.res, 413, { error: "too-large" }, ctx.headers)
        const input = Share(new TextDecoder().decode(raw))
        if (!input) return send(ctx.res, 400, { error: "invalid" }, ctx.headers)
        const shared = await deps.shares.put(session.userID, ctx.params[0]!, ctx.params[1]!, input)
        if (!shared) return send(ctx.res, 404, { error: "not-found" }, ctx.headers)
        send(ctx.res, 200, shared, ctx.headers)
      },
    },
    {
      method: "DELETE",
      path: /^\/projects\/([^/]+)\/shares\/([^/]+)$/,
      auth: true,
      run: async (ctx, session) => {
        if (!(await deps.shares.remove(session.userID, ctx.params[0]!, ctx.params[1]!)))
          return send(ctx.res, 404, { error: "not-found" }, ctx.headers)
        send(ctx.res, 204, undefined, ctx.headers)
      },
    },
    {
      // The public page behind a share link; no sign-in.
      method: "GET",
      path: /^\/shares\/([^/]+)$/,
      auth: false,
      run: async (ctx) => {
        const shared = await deps.shares.read(ctx.params[0]!)
        if (!shared) return send(ctx.res, 404, { error: "not-found" }, ctx.headers)
        send(ctx.res, 200, shared, ctx.headers)
      },
    },
    // Users & Roles: admins only. To everyone else these routes don't exist.
    {
      method: "GET",
      path: /^\/admin\/users$/,
      auth: true,
      run: async (ctx, session) => {
        if (!session.admin) return send(ctx.res, 404, { error: "not-found" }, ctx.headers)
        send(ctx.res, 200, await Users.list(deps.db), ctx.headers)
      },
    },
    {
      method: "POST",
      path: /^\/admin\/users$/,
      auth: true,
      run: async (ctx, session) => {
        if (!session.admin) return send(ctx.res, 404, { error: "not-found" }, ctx.headers)
        const input = await body(ctx.req, CreateUser)
        if (!input) return send(ctx.res, 400, { error: "invalid-request" }, ctx.headers)
        const invalid = !USERNAME.test(input.username.trim())
          ? "invalid-username"
          : !EMAIL.test(input.email.trim()) || input.email.length > 254
            ? "invalid-email"
            : input.password.length < PASSWORD_MIN
              ? "weak-password"
              : !(await sharedModel(input.model))
                ? "invalid-model"
                : undefined
        if (invalid) return send(ctx.res, 400, { error: invalid }, ctx.headers)
        const created = await Users.create(deps.db, { ...input, hidden: input.hidden ? [...input.hidden] : undefined })
          .then((user) => user.id)
          .catch((error: unknown) => {
            if (error instanceof Users.UserExists) return undefined
            throw error
          })
        if (!created) return send(ctx.res, 409, { error: "exists" }, ctx.headers)
        const users = await Users.list(deps.db)
        send(
          ctx.res,
          201,
          users.find((user) => user.id === created),
          ctx.headers,
        )
      },
    },
    {
      method: "PATCH",
      path: /^\/admin\/users\/([^/]+)$/,
      auth: true,
      run: async (ctx, session) => {
        if (!session.admin) return send(ctx.res, 404, { error: "not-found" }, ctx.headers)
        const input = await body(ctx.req, UpdateUser)
        if (!input) return send(ctx.res, 400, { error: "invalid-request" }, ctx.headers)
        const id = ctx.params[0]!
        // An admin can't lock themselves out of this page.
        if (id === session.userID && input.admin === false)
          return send(ctx.res, 400, { error: "self-demote" }, ctx.headers)
        if (input.password !== undefined && input.password.length < PASSWORD_MIN)
          return send(ctx.res, 400, { error: "weak-password" }, ctx.headers)
        if (!(await sharedModel(input.model))) return send(ctx.res, 400, { error: "invalid-model" }, ctx.headers)
        const updated = await Users.update(deps.db, id, {
          ...input,
          hidden: input.hidden ? [...input.hidden] : undefined,
        })
        if (!updated) return send(ctx.res, 404, { error: "not-found" }, ctx.headers)
        send(ctx.res, 200, updated, ctx.headers)
      },
    },
    {
      method: "DELETE",
      path: /^\/admin\/users\/([^/]+)$/,
      auth: true,
      run: async (ctx, session) => {
        if (!session.admin) return send(ctx.res, 404, { error: "not-found" }, ctx.headers)
        if (ctx.params[0] === session.userID) return send(ctx.res, 400, { error: "self-delete" }, ctx.headers)
        if (!(await Users.remove(deps.db, ctx.params[0]!)))
          return send(ctx.res, 404, { error: "not-found" }, ctx.headers)
        send(ctx.res, 204, undefined, ctx.headers)
      },
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

  // A user can only be locked to a model the admin shares with everyone, and that can be used.
  async function sharedModel(model: { providerID: string; modelID: string } | null | undefined) {
    if (!model) return true
    const shared = await usableShared()
    return shared.some((item) => item.providerID === model.providerID && item.modelID === model.modelID)
  }

  // The shared models people can actually use: switched on, from a provider the platform server still has connected.
  // A model whose provider was disconnected stays switched on for when it comes back, but no one is offered it.
  // When the platform server can't answer (still starting), the switched-on list stands in rather than nothing.
  async function usableShared() {
    const providers = await deps.shared().catch(() => undefined)
    if (!providers) return deps.platform.models()
    return providers
      .flatMap((provider) => provider.models.map((modelID) => ({ providerID: provider.id, modelID })))
      .toSorted((a, b) => `${a.providerID}/${a.modelID}`.localeCompare(`${b.providerID}/${b.modelID}`))
  }

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
