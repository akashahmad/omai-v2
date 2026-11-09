import { randomBytes, scrypt, timingSafeEqual } from "node:crypto"

// Same algorithm and format as the old project, so its users can move here unchanged:
// scrypt with a 64-byte key over the hex salt string, stored as `<32 hex salt>:<128 hex hash>`.

function derive(password: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, 64, (error, hash) => (error ? reject(error) : resolve(hash)))
  })
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex")
  return `${salt}:${(await derive(password, salt)).toString("hex")}`
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [salt, hash, extra] = stored.split(":")
  if (extra !== undefined || !/^[a-f0-9]{32}$/.test(salt ?? "") || !/^[a-f0-9]{128}$/.test(hash ?? "")) return false
  return timingSafeEqual(Buffer.from(hash, "hex"), await derive(password, salt))
}
