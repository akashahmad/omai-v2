import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"

export * as Secrets from "./secrets.js"

export type Secrets = Awaited<ReturnType<typeof load>>

/**
 * Encrypts users' provider credentials at rest (AES-256-GCM). The key is `OMAI_SECRETS_KEY` (32 bytes, base64); when
 * unset, one is generated into the data directory for local use, readable only by its owner.
 */
export async function load(dataDir: string, env: Record<string, string | undefined>) {
  const key = await readKey(dataDir, env.OMAI_SECRETS_KEY || undefined)
  return {
    seal(text: string) {
      const iv = randomBytes(12)
      const cipher = createCipheriv("aes-256-gcm", key, iv)
      const data = Buffer.concat([cipher.update(text, "utf8"), cipher.final()])
      return [iv, cipher.getAuthTag(), data].map((part) => part.toString("base64url")).join(".")
    },
    /** The text, or undefined when `sealed` is malformed or was sealed with another key. */
    open(sealed: string) {
      const parts = sealed.split(".")
      if (parts.length !== 3) return undefined
      const [iv, tag, data] = parts.map((part) => Buffer.from(part, "base64url"))
      if (iv!.length !== 12 || tag!.length !== 16) return undefined
      const decipher = createDecipheriv("aes-256-gcm", key, iv!)
      decipher.setAuthTag(tag!)
      try {
        return Buffer.concat([decipher.update(data!), decipher.final()]).toString("utf8")
      } catch {
        // A wrong key or tampered data fails authentication.
        return undefined
      }
    },
  }
}

async function readKey(dataDir: string, configured: string | undefined) {
  if (configured) {
    const key = Buffer.from(configured, "base64")
    if (key.length !== 32) throw new Error("OMAI_SECRETS_KEY must be 32 bytes, base64")
    return key
  }
  const file = path.join(dataDir, "secrets-key")
  const saved = (await readFile(file, "utf8").catch(() => "")).trim()
  if (saved) {
    const key = Buffer.from(saved, "base64")
    if (key.length !== 32) throw new Error(`${file} must hold 32 bytes, base64`)
    return key
  }
  const key = randomBytes(32)
  await mkdir(dataDir, { recursive: true })
  await writeFile(file, key.toString("base64"), { mode: 0o600 })
  return key
}
