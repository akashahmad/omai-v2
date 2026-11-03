export const available = true

export async function resolveBinary() {
  return process.env.OMAI_PTY_BIN || "opencode-pty"
}
