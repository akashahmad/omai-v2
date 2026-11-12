import { Credential } from "@opencode/schema/credential"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api"
import { FileNotFoundError, InvalidRequestError } from "../errors.js"

const Shared = Schema.Union([Credential.Key, Credential.OAuth])

export const PlatformProvider = Schema.Struct({
  id: Schema.String,
  integrationID: Schema.String,
  /** The real credential: an API key, or a sign-in already refreshed. */
  value: Shared,
  /** Each catalog model ID with the model name its API takes in requests. */
  models: Schema.Array(Schema.Struct({ id: Schema.String, api: Schema.String })),
}).annotate({ identifier: "PlatformProvider" })

export const PlatformRefreshInput = Schema.Struct({
  integrationID: Schema.String,
  value: Credential.OAuth,
}).annotate({ identifier: "PlatformRefreshInput" })

/**
 * Only on the platform server (`OMAI_PLATFORM_SECRET` set), and only with that secret in `x-omai-platform-secret`;
 * otherwise 404. Its own group, so it runs in a Location like the provider routes.
 */
export const PlatformGroup = HttpApiGroup.make("server.platform")
  .add(
    HttpApiEndpoint.get("platform.providers", "/api/experimental/platform/providers", {
      success: Schema.Array(PlatformProvider),
      error: [FileNotFoundError],
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "experimental.platform.providers",
        summary: "List the platform's providers and credentials",
        description:
          "The providers connected on this platform server with an API key or a sign-in, with their current credentials, which the control plane hands to project VMs. Experimental: may change without compatibility guarantees.",
        transform: (operation) => ({ ...operation, tags: ["experimental"] }),
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("platform.refresh", "/api/experimental/platform/refresh", {
      payload: PlatformRefreshInput,
      success: Credential.OAuth,
      error: [FileNotFoundError, InvalidRequestError],
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "experimental.platform.refresh",
        summary: "Refresh a sign-in",
        description:
          "Runs the integration's own refresh for a sign-in the control plane keeps for a user, and returns the new tokens. Experimental: may change without compatibility guarantees.",
        transform: (operation) => ({ ...operation, tags: ["experimental"] }),
      }),
    ),
  )
