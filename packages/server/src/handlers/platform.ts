import { timingSafeEqual } from "node:crypto"
import { PlatformProviders } from "@opencode/core/platform/providers"
import { FileNotFoundError } from "@opencode/protocol/errors"
import { Effect } from "effect"
import type { HttpServerRequest } from "effect/http"
import { HttpApiBuilder } from "effect/http-api"
import { Api } from "../api"

const missing = new FileNotFoundError({ path: "/api/experimental/platform/providers", message: "Not found" })

/**
 * `platform.providers`: the platform server's provider keys, for the control plane's gateway. Answers only on the
 * platform server, and only to a request carrying its secret, so no admin's browser (or anything else) reads them.
 */
export const PlatformHandler = HttpApiBuilder.group(Api, "server.platform", (handlers) =>
  Effect.succeed(handlers.handle("platform.providers", (ctx) => providers(ctx.request))),
)

function providers(request: HttpServerRequest.HttpServerRequest) {
  if (!allowed(request.headers["x-omai-platform-secret"], process.env.OMAI_PLATFORM_SECRET)) return Effect.fail(missing)
  return PlatformProviders.current
}

/** Whether `sent` is the platform secret; never true when this isn't the platform server. */
export function allowed(sent: unknown, secret: string | undefined) {
  return !!secret && typeof sent === "string" && same(sent, secret)
}

function same(a: string, b: string) {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}
