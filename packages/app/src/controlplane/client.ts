export * as ControlPlaneClient from "./client"

import { Option, Schema } from "effect"

const UserSchema = Schema.Struct({
  id: Schema.String,
  username: Schema.String,
  email: Schema.String,
  /** Admins set up the platform's providers and models. */
  admin: Schema.Boolean,
})

const IssuedSchema = Schema.Struct({ accessToken: Schema.String, user: UserSchema })

const ProjectSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  slug: Schema.String,
  vmState: Schema.Literals(["creating", "running", "pausing", "paused", "resuming", "failed"]),
  vmError: Schema.optional(Schema.String),
  lastSession: Schema.optional(Schema.Struct({ title: Schema.String, at: Schema.Number })),
  thumbnail: Schema.optional(Schema.String),
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
})

const OpenSchema = Schema.Struct({ routerUrl: Schema.String, token: Schema.String, directory: Schema.String })

const ConfigSchema = Schema.Struct({ signupEnabled: Schema.Boolean })

const ErrorSchema = Schema.Struct({ error: Schema.String })

const ClaimsSchema = Schema.Struct({ exp: Schema.Number })

const ModelKeySchema = Schema.Struct({ providerID: Schema.String, modelID: Schema.String })

export type User = typeof UserSchema.Type

export type ProjectView = typeof ProjectSchema.Type

export type OpenResult = typeof OpenSchema.Type

/** The session is over; the app shows the login page. */
export class Unauthenticated extends Error {
  constructor() {
    super("Signed out")
  }
}

export class RequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
  ) {
    super(code ?? `Request failed (${status})`)
  }
}

/** Multi-user mode is on when the build names a control plane. */
export function multiUser(): string | undefined {
  return import.meta.env.VITE_OMAI_API_URL || undefined
}

// Refresh this long before the access token expires.
const REFRESH_EARLY_MS = 30_000

/**
 * Talks to the control plane. The access token lives in memory only; the refresh token is an HttpOnly cookie the
 * browser sends with `credentials: "include"`.
 */
export function make(
  apiUrl: string,
  fetchImpl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> = (input, init) => fetch(input, init),
) {
  const base = apiUrl.replace(/\/+$/, "")
  const state: { token?: string; refreshing?: Promise<User | undefined> } = {}
  const listeners = new Set<() => void>()

  const raw = (path: string, init: RequestInit = {}, token?: string) =>
    fetchImpl(`${base}${path}`, {
      ...init,
      credentials: "include",
      headers: {
        ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
    })

  const accept = async (res: Response) => {
    const body = await decode(res, IssuedSchema)
    state.token = body.accessToken

    return body.user
  }

  function refresh() {
    state.refreshing ??= raw("/auth/refresh", { method: "POST" })
      .then(async (res) => {
        if (res.ok) return accept(res)
        state.token = undefined
        listeners.forEach((fn) => fn())

        return undefined
      })
      .finally(() => {
        state.refreshing = undefined
      })

    return state.refreshing
  }

  /** An authenticated request: refreshes early, and once more on a 401. */
  async function call(path: string, init: RequestInit = {}) {
    if (!state.token || expiresSoon(state.token)) await refresh()

    if (!state.token) throw new Unauthenticated()
    const first = await raw(path, init, state.token)

    if (first.status !== 401) return first
    await refresh()

    if (!state.token) throw new Unauthenticated()
    const second = await raw(path, init, state.token)

    if (second.status === 401) throw new Unauthenticated()

    return second
  }

  async function json<A, E extends string = never>(
    path: string,
    init: RequestInit,
    schema: Schema.Codec<A, unknown>,
    expected: Partial<Record<number, E>> = {},
  ): Promise<A | E> {
    const res = await call(path, init)
    const known = expected[res.status]

    if (known) return known

    if (!res.ok) throw new RequestError(res.status, await errorCode(res))

    return decode(res, schema)
  }

  async function empty(path: string, init: RequestInit) {
    const res = await call(path, init)

    if (!res.ok) throw new RequestError(res.status, await errorCode(res))
  }

  const body = (value: unknown) => JSON.stringify(value)

  return {
    token: () => state.token,
    /** For tests and for the session gate restoring a token. */
    setToken: (token: string | undefined) => {
      state.token = token
    },
    onSignedOut(fn: () => void) {
      listeners.add(fn)

      return () => listeners.delete(fn)
    },
    async config() {
      const res = await raw("/config")

      if (!res.ok) throw new RequestError(res.status, await errorCode(res))

      return decode(res, ConfigSchema)
    },
    async login(input: { login: string; password: string }): Promise<User | "invalid"> {
      const res = await raw("/auth/login", { method: "POST", body: body(input) })

      if (res.status === 401 || res.status === 400) return "invalid"

      if (!res.ok) throw new RequestError(res.status, await errorCode(res))

      return accept(res)
    },
    async signup(input: {
      username: string
      email: string
      password: string
    }): Promise<User | "exists" | "disabled" | "invalid"> {
      const res = await raw("/auth/signup", { method: "POST", body: body(input) })

      if (res.status === 404) return "disabled"

      if (res.status === 409) return "exists"

      if (res.status === 400) return "invalid"

      if (!res.ok) throw new RequestError(res.status, await errorCode(res))

      return accept(res)
    },
    refresh,
    ping: () => empty("/auth/ping", { method: "POST" }),
    async logout() {
      const token = state.token
      state.token = undefined

      if (token) await raw("/auth/logout", { method: "POST" }, token).catch(() => undefined)
    },
    models: {
      /** The models an admin shared with everyone (names only). */
      shared: () => json("/models/shared", {}, Schema.Array(ModelKeySchema)),
    },
    /** Platform settings, for admins: the platform server (provider keys) and the models switched on for everyone. */
    platform: {
      open: () => json("/platform/open", { method: "POST" }, OpenSchema),
      models: () => json("/platform/models", {}, Schema.Array(ModelKeySchema)),
      setModels: (models: readonly { providerID: string; modelID: string }[]) =>
        empty("/platform/models", { method: "PUT", body: body({ models }) }),
    },
    projects: {
      list: () => json("/projects", {}, Schema.Array(ProjectSchema)),
      create: (name: string) =>
        json("/projects", { method: "POST", body: body({ name }) }, ProjectSchema, { 409: "exists", 400: "invalid" }),
      get: (id: string) => json(`/projects/${encodeURIComponent(id)}`, {}, ProjectSchema),
      rename: (id: string, name: string) =>
        json(`/projects/${encodeURIComponent(id)}`, { method: "PATCH", body: body({ name }) }, ProjectSchema, {
          409: "exists",
          400: "invalid",
        }),
      /** The latest preview screenshot as a WebP blob, or undefined when there is none. */
      thumbnail: async (id: string) => {
        const res = await call(`/projects/${encodeURIComponent(id)}/thumbnail`, {})

        if (res.status === 404) return undefined

        if (!res.ok) throw new RequestError(res.status, await errorCode(res))

        return res.blob()
      },
      remove: (id: string) => empty(`/projects/${encodeURIComponent(id)}`, { method: "DELETE" }),
      retry: (id: string) => json(`/projects/${encodeURIComponent(id)}/retry`, { method: "POST" }, ProjectSchema),
      /** The open project is in use: keeps its VM from pausing. */
      presence: (id: string) => empty(`/projects/${encodeURIComponent(id)}/presence`, { method: "POST" }),
      /** Starts a paused VM in the background, so opening it is quick. */
      wake: (id: string) => empty(`/projects/${encodeURIComponent(id)}/wake`, { method: "POST" }),
      open: (id: string) =>
        json(`/projects/${encodeURIComponent(id)}/open`, { method: "POST" }, OpenSchema, { 409: "not-ready" }),
    },
  }
}

export type Client = ReturnType<typeof make>

function expiresSoon(token: string) {
  const exp = readExp(token)

  return exp !== undefined && exp * 1000 - Date.now() < REFRESH_EARLY_MS
}

const decodeClaims = Schema.decodeUnknownOption(Schema.fromJsonString(ClaimsSchema))

const decodeError = Schema.decodeUnknownOption(Schema.fromJsonString(ErrorSchema))

// The client only reads `exp`, to refresh in time; the control plane checks the signature.
function readExp(token: string) {
  const payload = token.split(".")[0] ?? ""
  const json = atob(payload.replaceAll("-", "+").replaceAll("_", "/"))

  return Option.getOrUndefined(decodeClaims(json))?.exp
}

async function decode<A>(res: Response, schema: Schema.Codec<A, unknown>): Promise<A> {
  const text = await res.text()

  return Option.getOrThrowWith(
    Schema.decodeUnknownOption(Schema.fromJsonString(schema))(text),
    () => new RequestError(res.status, "invalid-response"),
  )
}

async function errorCode(res: Response) {
  return Option.getOrUndefined(decodeError(await res.text()))?.error
}
