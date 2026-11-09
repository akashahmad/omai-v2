#!/usr/bin/env bun
// Prints a fresh Ed25519 key pair in the one-line form the env files use.
import { SignedToken } from "@opencode/util/signed-token"

const keys = SignedToken.generateKeyPair()
const line = (pem: string) => `"${pem.trim().replaceAll("\n", "\\n")}"`
console.log(`OMAI_TOKEN_SIGNING_KEY=${line(keys.privateKeyPem)}`)
console.log(`OMAI_TOKEN_PUBLIC_KEY=${line(keys.publicKeyPem)}`)
