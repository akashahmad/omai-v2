#!/usr/bin/env bun
// Builds the project VM image, smoke-tests it, and pushes it only with --push.
// Usage (from packages/controlplane): bun script/vm-image.ts --image docker.io/jj123dev/omai-microvm --tag <tag> [--push]
import path from "node:path"
import { SignedToken } from "@opencode/util/signed-token"
import { vmToken } from "../src/vm/provision.js"

const root = path.resolve(import.meta.dir, "../../..")
const arg = (name: string) => process.argv[process.argv.indexOf(`--${name}`) + 1]
const repo = process.argv.includes("--image") ? arg("image") : undefined
const tag = process.argv.includes("--tag") ? arg("tag") : undefined
if (!repo || !tag) throw new Error("Usage: bun script/vm-image.ts --image docker.io/jj123dev/omai-microvm --tag <tag> [--push]")
const image = `${repo}:${tag}`

// The context is the repository; .dockerignore keeps env files, git and build output out of it.
run(["docker", "build", "--platform", "linux/amd64", "-f", path.join(root, "docker/microvm/Dockerfile"), "-t", image, root])

await smoke()
const size = Number(capture(["docker", "image", "inspect", image, "--format", "{{.Size}}"]))
console.log(`\n${image}: ${(size / 1024 / 1024).toFixed(0)} MB`)
if (process.argv.includes("--push")) run(["docker", "push", image])

/** Runs the image the way Northflank does: a volume at /home/omai and only the VM's variables. */
async function smoke() {
  const id = crypto.randomUUID().slice(0, 8)
  const volume = `omai-vm-smoke-${id}`
  const keys = SignedToken.generateKeyPair()
  const projectID = `smoke-${id}`
  const env = {
    OMAI_PROJECT_ID: projectID,
    OMAI_PROJECT_SLUG: "smoke",
    OMAI_PROJECT_TOKEN: "smoke-token",
    OMAI_CONTROL_PLANE_URL: "http://127.0.0.1:9",
    OMAI_TOKEN_PUBLIC_KEY: keys.publicKeyPem,
    OMAI_APP_ORIGIN: "http://localhost:4455",
    OMAI_PREVIEW_PORT: "4097",
  }
  const start = (name: string) =>
    capture([
      "docker", "run", "-d", "--platform", "linux/amd64", "--name", name, "-v", `${volume}:/home/omai`, "-p", "127.0.0.1::4096",
      ...Object.entries(env).flatMap(([key, value]) => ["-e", `${key}=${value}`]),
      image,
    ])
  const exec = (name: string, command: string, user = "root") =>
    capture(["docker", "exec", "-u", user, name, "sh", "-c", command])
  const names = [`${volume}-a`, `${volume}-b`]
  try {
    start(names[0]!)
    const started = Date.now()
    await ready(names[0]!, projectID, keys.privateKeyPem)
    console.log(`server answered after ${((Date.now() - started) / 1000).toFixed(1)} s`)
    check("runs as omai", exec(names[0]!, "stat -c %U /proc/1"), "omai")
    check("no sudo", exec(names[0]!, "command -v sudo || echo none"), "none")
    const keysSeen = exec(names[0]!, "tr '\\0' '\\n' < /proc/1/environ | cut -d= -f1 | sort").split("\n")
    const extra = keysSeen.filter(
      (key) => !(key in env) && !["PATH", "HOME", "HOSTNAME", "USER", "LOGNAME", "CHROME_PATH"].includes(key),
    )
    check("environment holds only the VM's variables", extra.join(",") || "none", "none")
    check("no env files or keys in the image", exec(names[0]!, "find / -xdev \\( -name '.env' -o -name '.env.*' -o -name '*.key' -o -name 'id_rsa*' \\) -not -path '/proc/*' 2>/dev/null | head -5 || true") || "none", "none")
    check("chromium runs", exec(names[0]!, "chromium --headless --no-sandbox --version 2>/dev/null | head -1 | cut -c1-8"), "Chromium")
    exec(names[0]!, "echo kept > /home/omai/smoke.txt", "omai")
    // A paused VM comes back as a new container on the same volume.
    capture(["docker", "rm", "-f", names[0]!])
    start(names[1]!)
    await ready(names[1]!, projectID, keys.privateKeyPem)
    check("files survive a restart", exec(names[1]!, "cat /home/omai/smoke.txt"), "kept")
  } finally {
    for (const name of names) Bun.spawnSync(["docker", "rm", "-f", name], { stdout: "ignore", stderr: "ignore" })
    Bun.spawnSync(["docker", "volume", "rm", volume], { stdout: "ignore", stderr: "ignore" })
  }
}

async function ready(name: string, projectID: string, signingKey: string) {
  const port = capture(["docker", "port", name, "4096/tcp"]).split(":").at(-1)
  const host = `http://127.0.0.1:${port}`
  const token = vmToken({ signingKey }, { userID: "smoke", projectID, sessionID: "smoke", host })
  const authorization = `Basic ${Buffer.from(`omai:${token}`).toString("base64")}`
  const deadline = Date.now() + 180_000
  while (Date.now() < deadline) {
    const status = await fetch(`${host}/api/info`, { headers: { authorization }, signal: AbortSignal.timeout(2000) }).then(
      (res) => res.status,
      () => 0,
    )
    if (status === 200) return
    await Bun.sleep(1000)
  }
  console.error(capture(["docker", "logs", "--tail", "40", name]))
  throw new Error("the server did not answer on 4096")
}

function check(label: string, actual: string, expected: string) {
  if (actual.trim() !== expected) throw new Error(`${label}: expected "${expected}", got "${actual.trim()}"`)
  console.log(`ok  ${label}`)
}

function capture(command: string[]) {
  const result = Bun.spawnSync(command, { stdout: "pipe", stderr: "pipe" })
  if (result.exitCode !== 0) throw new Error(`${command.slice(0, 3).join(" ")} failed: ${result.stderr.toString().slice(-500)}`)
  return result.stdout.toString().trim()
}

function run(command: string[]) {
  const result = Bun.spawnSync(command, {
    cwd: root,
    stdout: "inherit",
    stderr: "inherit",
  })
  if (result.exitCode !== 0) throw new Error(`${command.join(" ")} failed`)
}
