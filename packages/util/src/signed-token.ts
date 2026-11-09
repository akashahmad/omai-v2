import { createPrivateKey, createPublicKey, generateKeyPairSync, sign as signBytes, verify as verifyBytes } from "node:crypto"
import { Option, Schema } from "effect"

export * as SignedToken from "./signed-token.js"

const Vm = Schema.Struct({
  typ: Schema.Literal("vm"),
  sub: Schema.String,
  pid: Schema.String,
  sid: Schema.String,
  host: Schema.String,
  exp: Schema.Number,
})
const Access = Schema.Struct({
  typ: Schema.Literal("access"),
  sub: Schema.String,
  sid: Schema.String,
  exp: Schema.Number,
})

export type VmClaims = typeof Vm.Type
export type AccessClaims = typeof Access.Type

const decodeClaims = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Union([Vm, Access])))

/** `base64url(JSON claims) + "." + base64url(Ed25519 signature over the first part)`. */
export function sign(claims: VmClaims | AccessClaims, privateKeyPem: string) {
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url")
  const signature = signBytes(null, Buffer.from(payload), createPrivateKey(pem(privateKeyPem)))
  return `${payload}.${signature.toString("base64url")}`
}

/** Undefined for a malformed token, a bad signature or an expired one. */
export function verify(token: string, publicKeyPem: string, now = Date.now()) {
  const parts = token.split(".")
  if (parts.length !== 2 || !parts[0] || !parts[1]) return undefined
  const valid = verifyBytes(
    null,
    Buffer.from(parts[0]),
    createPublicKey(pem(publicKeyPem)),
    Buffer.from(parts[1], "base64url"),
  )
  if (!valid) return undefined
  const claims = Option.getOrUndefined(decodeClaims(Buffer.from(parts[0], "base64url").toString("utf8")))
  if (!claims || claims.exp * 1000 <= now) return undefined
  return claims
}

export function generateKeyPair() {
  const pair = generateKeyPairSync("ed25519")
  return {
    privateKeyPem: pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKeyPem: pair.publicKey.export({ type: "spki", format: "pem" }).toString(),
  }
}

// Env files store PEM on one line with literal "\n"; accept both forms.
function pem(value: string) {
  return value.replaceAll("\\n", "\n")
}
