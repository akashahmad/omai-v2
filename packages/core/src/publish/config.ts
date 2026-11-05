export * as PublishConfig from "./config.js"

export const KV_TITLE = "omai-hostnames"
export const DISPATCHER = "omai-dispatcher"

export type Config = {
  accountID: string
  token: string
  zone: string
  namespace: string
  apexIPs: string[]
  api: string
}

/** The Cloudflare settings, or undefined when publishing is not set up (no account or token). */
export function read(env: Record<string, string | undefined> = process.env): Config | undefined {
  const accountID = env.OMAI_CLOUDFLARE_ACCOUNT_ID?.trim()
  const token = env.OMAI_CLOUDFLARE_API_TOKEN?.trim()
  if (!accountID || !token) return undefined
  return {
    accountID,
    token,
    zone: env.OMAI_CLOUDFLARE_PLATFORM_ZONE?.trim() || "omai.ch",
    namespace: env.OMAI_CLOUDFLARE_DISPATCH_NAMESPACE?.trim() || "omai-apps",
    apexIPs: (env.OMAI_CLOUDFLARE_APEX_IPS ?? "")
      .split(",")
      .map((ip) => ip.trim())
      .filter(Boolean),
    api: env.OMAI_CLOUDFLARE_API_BASE?.trim() || "https://api.cloudflare.com/client/v4",
  }
}

/** The DNS name customers point their domains at. */
export const target = (zone: string) => `domains.${zone}`
