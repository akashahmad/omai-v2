export * as ServerProcess from "./process"

import { NodeHttpServer } from "@effect/platform-node"
import { Bus } from "@opencode/core/bus"
import { SessionRestart } from "@opencode/core/session/execution/restart"
import { Schedule } from "@opencode/core/schedule"
import { InstallationEvent } from "@opencode/schema/installation-event"
import { hasPtyConnectTicketURL } from "@opencode/protocol/groups/pty"
import { hasPersistentPtyConnectTicketURL } from "@opencode/protocol/groups/persistent-pty"
import { hasMcpClientTicketURL } from "@opencode/protocol/groups/mcp"
import { isPairingConnectURL } from "@opencode/protocol/groups/server"
import { Global } from "@opencode/util/global"
import { Cause, Context, Effect, Exit, Latch, Layer, Option, Ref, Scope } from "effect"
import { HttpMiddleware, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
import { NetAddress } from "effect/net"
import { createServer } from "node:http"
import { ServerAuth } from "./auth"
import { ProjectVmBusy } from "@opencode/core/project-vm/busy"
import { ProjectVmCredentials } from "@opencode/core/project-vm/credentials"
import { ProjectVmUsage } from "@opencode/core/project-vm/usage"
import { ProjectVmSummary } from "@opencode/core/project-vm/summary"
import { ProjectVmThumbnail } from "@opencode/core/project-vm/thumbnail"
import { PreviewThumbnail } from "@opencode/core/preview/thumbnail"
import { Database } from "@opencode/core/database/database"
import { isAllowedCorsOrigin, isAllowedRequestOrigin } from "./cors"
import { authorizedRequest, unauthorizedResponse } from "./middleware/authorization"
import { withoutParentSpan } from "./request-tracing"
import { createRoutes } from "./routes"
import { ServerInfo } from "./server-info"
import { Status } from "./service-status"
import type { ServerOptions } from "./options"

export interface Lifecycle<E = never, R = never> {
  readonly onListen: (
    address: NetAddress.SocketAddress,
    shutdown: Effect.Effect<void>,
  ) => Effect.Effect<Effect.Effect<void>, E, R>
}

type App = Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  unknown,
  HttpServerRequest.HttpServerRequest | Scope.Scope
>

export type Transform = (app: App) => App

const errorResponseLogger = HttpMiddleware.make((app) =>
  HttpMiddleware.logger(
    Effect.tap(app, (response) =>
      response.status < 400 ? HttpMiddleware.withLoggerDisabled(Effect.void) : Effect.void,
    ),
  ),
)

export const start = Effect.fn("ServerProcess.start")(function* <E, R>(
  options: ServerOptions,
  lifecycle?: Lifecycle<E, R>,
  transform?: Transform,
  remoteURLs?: () => ReadonlyArray<string>,
) {
  const password = options.password || undefined
  const vm = ServerAuth.vmFromEnv()
  const hostname = options.hostname ?? "127.0.0.1"
  // Without a password anything that can reach the port can drive the server, so only this machine may. A MicroVM
  // has no password but only accepts VM tokens for its own project.
  if (!password && !vm && !isLoopback(hostname))
    return yield* Effect.fail(
      new Error(`Set OMAI_PASSWORD to listen on ${hostname}; without a password the server only listens on loopback`),
    )
  const port = Option.fromNullishOr(options.port)
  // The preview plugin listens beside the server, on the same host, and asks for a ticket when the server has a
  // password. The password itself is cleared from the environment at startup, so only the fact is passed on.
  process.env.OMAI_PREVIEW_HOSTNAME = hostname
  process.env.OMAI_PREVIEW_AUTH = password || vm ? "1" : "0"
  const shutdown = yield* Latch.make()
  const status = yield* Status.make()
  const bound = yield* listen({ hostname, port })
  const localURLs = () => {
    const address = bound.server.address()
    if (address === null || typeof address === "string") return []
    const host = address.family === "IPv6" ? `[${address.address}]` : address.address
    return ServerInfo.connectionURLs(`http://${host}:${address.port}`, hostname)
  }
  const urls = () => [...localURLs(), ...(remoteURLs?.() ?? [])]
  const application = yield* Ref.make(Option.none<App>())
  const app = dispatch(
    password,
    vm,
    options,
    status,
    application,
    options.app?.version ?? "unknown",
    urls,
    Global.Path.tmp,
  )
  // Request fibers may continue inbound trace context, but must not inherit the server startup parent.
  yield* bound.http
    .serve(
      (transform ? transform(app) : app).pipe(
        HttpMiddleware.compression(),
        HttpMiddleware.cors({ allowedOrigins: (origin) => isAllowedCorsOrigin(origin, options), maxAge: 86_400 }),
      ),
      errorResponseLogger,
    )
    .pipe(Effect.provide(NodeHttpServer.layerHttpServices), withoutParentSpan)
  if (lifecycle)
    yield* lifecycle.onListen(bound.http.address, shutdown.open.pipe(Effect.asVoid)).pipe(
      Effect.flatMap((cleanup) =>
        Effect.addFinalizer(() => Scope.close(bound.scope, Exit.void).pipe(Effect.andThen(cleanup))),
      ),
      Effect.uninterruptible,
    )

  const parentScope = yield* Scope.Scope
  const applicationScope = yield* Scope.fork(parentScope)
  yield* Effect.addFinalizer(() =>
    status.beginStopping.pipe(
      Effect.andThen(Ref.set(application, Option.none())),
      Effect.andThen(Effect.sync(() => bound.server.closeAllConnections())),
    ),
  )

  // Built without the startup span: route handlers and background fibers capture this context, and would
  // otherwise nest every request and session turn for the life of the process under one trace.
  const boot = Effect.gen(function* () {
    const context = yield* Layer.buildWithScope(
      createRoutes(
        {
          ...options,
          password,
        },
        urls,
      ).pipe(Layer.provideMerge(NodeHttpServer.layerHttpServices)),
      applicationScope,
    )
    if (lifecycle) {
      yield* installRestartContinuity(Context.get(context, SessionRestart.Service)).pipe(
        Effect.provideService(Scope.Scope, applicationScope),
      )
    }
    // Schedules fire from any server process (`service`, `omai serve`, or `--standalone`); the table holds all their state.
    yield* Effect.forkIn(Context.get(context, Schedule.Service).run, applicationScope)
    // On a project's MicroVM, keep the control plane's projects page up to date with the latest session.
    const controlPlane = process.env.OMAI_CONTROL_PLANE_URL
    const projectID = process.env.OMAI_PROJECT_ID
    const projectToken = process.env.OMAI_PROJECT_TOKEN
    if (controlPlane && projectID && projectToken) {
      yield* Effect.forkIn(
        ProjectVmSummary.start({ url: controlPlane, projectID, token: projectToken }).pipe(Effect.provide(context)),
        applicationScope,
      )
      // The user's own provider credentials, the same on all their projects, and the tokens each AI step used.
      const target = { url: controlPlane.replace(/\/+$/, ""), projectID, token: projectToken }
      yield* Effect.forkIn(ProjectVmCredentials.start(target).pipe(Effect.provide(context)), applicationScope)
      yield* Effect.forkIn(ProjectVmUsage.start(target).pipe(Effect.provide(context)), applicationScope)
      // Every 10 s, whether this VM is busy, so the control plane never pauses it mid-work.
      yield* Effect.forkIn(
        ProjectVmBusy.push({
          url: controlPlane,
          projectID,
          token: projectToken,
          read: ProjectVmBusy.current.pipe(Effect.provide(context)),
        }),
        applicationScope,
      )
    }
    // Screenshots taken before the control plane kept them (or while it was unreachable) reach it on the next start.
    const thumbnailTarget = ProjectVmThumbnail.target()
    if (thumbnailTarget)
      yield* Effect.forkIn(
        PreviewThumbnail.latest(Context.get(context, Database.Service).db).pipe(
          Effect.flatMap((image) =>
            image ? Effect.promise(() => ProjectVmThumbnail.push(thumbnailTarget, image.data)) : Effect.void,
          ),
        ),
        applicationScope,
      )
    yield* Ref.set(application, Option.some(Context.get(context, HttpRouter.HttpRouter).asHttpEffect()))
    yield* status.ready
    const bus = Context.get(context, Bus.Service)
    return {
      address: bound.http.address,
      shutdown: shutdown.await,
      updateAvailable: (version: string) =>
        bus.publish(InstallationEvent.UpdateAvailable, { version }).pipe(Effect.asVoid),
      updated: (version: string) => bus.publish(InstallationEvent.Updated, { version }).pipe(Effect.asVoid),
    }
  }).pipe(
    withoutParentSpan,
    Effect.catchCause((cause) => {
      if (!lifecycle || Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause)
      return status.fail.pipe(
        Effect.andThen(
          Scope.close(applicationScope, Exit.failCause(cause)).pipe(
            Effect.catchCause((cleanupCause) =>
              Effect.logError("failed to clean up background service boot", { cause: cleanupCause }),
            ),
          ),
        ),
        Effect.andThen(Effect.logError("background service boot failed", { cause })),
        Effect.andThen(Effect.never),
      )
    }),
  )
  if (!lifecycle) return yield* boot
  return yield* Effect.raceFirst(boot, shutdown.await.pipe(Effect.andThen(Effect.interrupt)))
})

function listen(options: { readonly hostname: string; readonly port: Option.Option<number> }) {
  if (Option.isSome(options.port)) return bind(options.hostname, options.port.value)
  const next = (port: number): ReturnType<typeof bind> =>
    bind(options.hostname, port).pipe(
      Effect.catch((error) => (port < 65_535 && addressInUse(error) ? next(port + 1) : Effect.fail(error))),
    )
  return next(4096)
}

function bind(hostname: string, port: number) {
  return Effect.gen(function* () {
    const parentScope = yield* Scope.Scope
    const serverScope = yield* Scope.fork(parentScope)
    const server = createServer()
    return yield* Effect.gen(function* () {
      const http = yield* NodeHttpServer.make(() => server, { port, host: hostname })
      yield* Effect.addFinalizer(() => Effect.sync(() => server.closeAllConnections()))
      return { http, server, scope: serverScope }
    }).pipe(
      Effect.provideService(Scope.Scope, serverScope),
      Effect.onError((cause) => Scope.close(serverScope, Exit.failCause(cause))),
    )
  })
}

function addressInUse(error: unknown) {
  if (typeof error !== "object" || error === null || !("cause" in error)) return false
  const cause = error.cause
  return typeof cause === "object" && cause !== null && "code" in cause && cause.code === "EADDRINUSE"
}

function dispatch(
  password: string | undefined,
  vm: ServerAuth.VmAuth | undefined,
  cors: ServerOptions,
  status: Status.Interface,
  application: Ref.Ref<Option.Option<App>>,
  version: string,
  urls: () => ReadonlyArray<string>,
  tmp: string,
): App {
  const auth =
    password || vm
      ? ServerAuth.Config.of({ password: Option.fromNullishOr(password), username: "omai", vm })
      : undefined
  // Without a password, a page on another site could still send requests, so only allowed origins get through. The
  // Host must also be loopback: a site that rebinds its own name to 127.0.0.1 would otherwise count as same-host.
  const authorized = (request: HttpServerRequest.HttpServerRequest) =>
    auth
      ? authorizedRequest(request, auth)
      : Effect.succeed(
          isLoopback(hostOf(request.headers.host)) &&
            isAllowedRequestOrigin(request.headers.origin, request.headers.host, cors),
        )
  return Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const url = new URL(request.url, "http://localhost")
    const state = yield* status.current
    const app = yield* Ref.get(application)
    const ready = state.type === "ready" && Option.isSome(app)
    if (request.method === "GET" && url.pathname === "/api/info" && !ready) {
      if (!(yield* authorized(request))) return unauthorizedResponse(request)
      return yield* infoResponse(status, version, urls, tmp)
    }
    if (
      !isPairingConnectURL(url) &&
      (!ready ||
        (!hasPtyConnectTicketURL(url) && !hasPersistentPtyConnectTicketURL(url) && !hasMcpClientTicketURL(url))) &&
      !(yield* authorized(request))
    )
      return unauthorizedResponse(request)
    if (ready) return yield* app.value
    return unavailable(state)
  })
}

const infoResponse = Effect.fnUntraced(function* (
  status: Status.Interface,
  version: string,
  urls: () => ReadonlyArray<string>,
  tmp: string,
) {
  const state = yield* status.current
  return HttpServerResponse.jsonUnsafe(
    { version, pid: process.pid, urls: urls(), paths: { tmp } },
    {
      status: state.type === "ready" ? 200 : state.type === "failed" ? 500 : 503,
      headers: state.type === "starting" || state.type === "stopping" ? { "retry-after": "1" } : undefined,
    },
  )
})

function unavailable(status: Status.State) {
  if (status.type === "failed")
    return HttpServerResponse.jsonUnsafe(
      {
        code: "service_failed",
        message: "The background service could not start.",
        action: "Run `omai service restart` after checking the service logs.",
      },
      { status: 503 },
    )
  return HttpServerResponse.jsonUnsafe(
    { code: status.type === "stopping" ? "service_stopping" : "service_starting" },
    { status: 503, headers: { "retry-after": "1" } },
  )
}

/**
 * The managed server owns restart continuity: at boot it resumes Sessions whose execution claim was
 * never released. Claims are written when execution starts (see SessionExecution), so recovery covers
 * graceful restarts and unclean deaths alike — no shutdown hook participates.
 */
const installRestartContinuity = Effect.fnUntraced(function* (restart: SessionRestart.Interface) {
  yield* Effect.forkScoped(restart.resumeSuspendedSessions)
})

function hostOf(host: string | undefined) {
  if (!host) return ""
  return URL.parse(`http://${host}`)?.hostname ?? ""
}

function isLoopback(hostname: string) {
  return hostname === "localhost" || hostname === "::1" || hostname === "[::1]" || hostname.startsWith("127.")
}
