import { describe, expect, test } from "bun:test"
import { mkdtemp, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Secrets } from "../src/secrets.js"

describe("Secrets", () => {
  test("seals and opens; another key can't open; the generated key is kept, owner-only", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "omai-secrets-"))
    const first = await Secrets.load(dir, {})
    const sealed = first.seal('{"type":"key","key":"sk-1"}')
    expect(sealed).not.toContain("sk-1")
    expect(first.open(sealed)).toBe('{"type":"key","key":"sk-1"}')
    expect((await Secrets.load(dir, {})).open(sealed)).toBe('{"type":"key","key":"sk-1"}')
    expect((await stat(path.join(dir, "secrets-key"))).mode & 0o777).toBe(0o600)
    const other = await Secrets.load(dir, { OMAI_SECRETS_KEY: Buffer.alloc(32, 7).toString("base64") })
    expect(other.open(sealed)).toBeUndefined()
    expect(other.open("garbage")).toBeUndefined()
  })

  test("a saved key of the wrong size is refused", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "omai-secrets-"))
    await writeFile(path.join(dir, "secrets-key"), Buffer.alloc(16).toString("base64"))
    await expect(Secrets.load(dir, {})).rejects.toThrow(/32 bytes/)
  })
})
