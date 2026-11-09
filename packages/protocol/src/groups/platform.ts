import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api"
import { FileNotFoundError } from "../errors.js"

export const PlatformProvider = Schema.Struct({
  id: Schema.String,
  /** The header the provider's API takes its key in. */
  auth: Schema.Literals(["bearer", "x-api-key", "x-goog-api-key"]),
  key: Schema.String,
  /** Every API base URL the provider's models use; the gateway forwards nowhere else. */
  bases: Schema.Array(Schema.String),
  /** Each catalog model ID with the model name its API takes in requests. */
  models: Schema.Array(Schema.Struct({ id: Schema.String, api: Schema.String })),
}).annotate({ identifier: "PlatformProvider" })

/**
 * Only on the platform server (`OMAI_PLATFORM_SECRET` set), and only with that secret in `x-omai-platform-secret`;
 * otherwise 404. Its own group, so it runs in a Location like the provider routes.
 */
export const PlatformGroup = HttpApiGroup.make("server.platform").add(
  HttpApiEndpoint.get("platform.providers", "/api/experimental/platform/providers", {
    success: Schema.Array(PlatformProvider),
    error: [FileNotFoundError],
  }).annotateMerge(
    OpenApi.annotations({
      identifier: "experimental.platform.providers",
      summary: "List the platform's providers and keys",
      description:
        "The providers connected on this platform server with an API key, with their keys and API base URLs, for the control plane's model gateway. Experimental: may change without compatibility guarantees.",
      transform: (operation) => ({ ...operation, tags: ["experimental"] }),
    }),
  ),
)
