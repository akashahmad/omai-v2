export * as ServerAuth from "./auth"

import { Context, Layer, Option, Redacted } from "effect"
import { createHmac, timingSafeEqual } from "node:crypto"
import { SignedToken } from "@opencode/util/signed-token"

export type DecodedCredentials = {
  readonly username: string
  readonly password: Redacted.Redacted
}

/** Set on a project's MicroVM: the control plane's public key and the one project this server serves. */
export type VmAuth = {
  readonly publicKey: string
  readonly projectID: string
}

export type Info = {
  readonly password: Option.Option<string>
  readonly username: string
  readonly vm?: VmAuth
}

export function vmFromEnv(env: Record<string, string | undefined> = process.env): VmAuth | undefined {
  if (!env.OMAI_TOKEN_PUBLIC_KEY || !env.OMAI_PROJECT_ID) return undefined
  return { publicKey: env.OMAI_TOKEN_PUBLIC_KEY, projectID: env.OMAI_PROJECT_ID }
}

export const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60

export class Config extends Context.Service<Config, Info>()("@opencode/ServerAuthConfig") {
  static configLayer(input: Pick<Info, "password" | "vm">) {
    return Layer.succeed(this, this.of({ ...input, username: "omai" }))
  }

  static get layer() {
    return this.configLayer({ password: Option.none() })
  }
}

export function required(config: Info) {
  return (Option.isSome(config.password) && config.password.value !== "") || config.vm !== undefined
}

// Session tokens issued by pairing links are accepted anywhere the password is. On a MicroVM, a VM token for this
// server's project is accepted as the password too.
export function authorized(credentials: DecodedCredentials, config: Info) {
  if (credentials.username !== config.username) return false
  const password = Redacted.value(credentials.password)
  if (config.vm && verifyVmToken(password, config.vm)) return true
  if (Option.isNone(config.password)) return false
  return password === config.password.value || verifySession(password, config)
}

function verifyVmToken(token: string, vm: VmAuth) {
  const claims = SignedToken.verify(token, vm.publicKey)
  return claims?.typ === "vm" && claims.pid === vm.projectID
}

// Sessions are signed with a key derived from the server password, so rotating the password revokes every session.
export function issueSession(config: Info, now = Date.now()) {
  if (Option.isNone(config.password)) return
  const expires = String(Math.floor(now / 1000) + SESSION_TTL_SECONDS)
  return `${expires}.${sign(config.password.value, expires)}`
}

export function verifySession(token: string, config: Info, now = Date.now()) {
  if (Option.isNone(config.password)) return false
  const parts = token.split(".")
  if (parts.length !== 2) return false
  const expires = Number(parts[0])
  if (!Number.isSafeInteger(expires) || expires * 1000 <= now) return false
  const expected = Buffer.from(sign(config.password.value, parts[0]))
  const actual = Buffer.from(parts[1])
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

// Browsers share cookies across ports on the same host, so the name carries the port to keep local servers apart.
export function sessionCookieName(host: string | undefined) {
  const port = URL.parse(`http://${host ?? ""}`)?.port
  return port ? `omai_session_${port}` : "omai_session"
}

function sign(password: string, payload: string) {
  const key = createHmac("sha256", password).update("omai-session-v1").digest()
  return createHmac("sha256", key).update(payload).digest("base64url")
}
