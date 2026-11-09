import { execFile, spawn, type ChildProcess } from "node:child_process"
import { createWriteStream } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import path from "node:path"
import { Option, Schema } from "effect"
import type { Config } from "../config.js"
import type { VmAddress, VmProvider, VmSpec } from "./provider.js"

export * as LocalVmProvider from "./local.js"

const decodeSpec = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      projectID: Schema.String,
      slug: Schema.String,
      env: Schema.Record(Schema.String, Schema.String),
      // Absent in specs saved before ports were kept.
      port: Schema.optional(Schema.Number),
    }),
  ),
)

/**
 * One `omai serve` process per project on this machine, standing in for a MicroVM. Each project
 * gets `<localProjectsRoot>/<projectID>/home` as its home. The spec is kept beside it so the
 * process can start again after the control plane restarts, on the same port: VM tokens carry the address.
 */
export function make(
  config: Pick<Config, "localProjectsRoot" | "localServeCommand" | "appOrigin"> & {
    /** Serve every VM at this address, listening on all interfaces at its port (for a provider of one VM). */
    fixedUrl?: string
  },
) {
  const fixedPort = config.fixedUrl ? Number(new URL(config.fixedUrl).port) : undefined
  const running = new Map<string, { child: ChildProcess; address: VmAddress }>()
  const dir = (projectID: string) => path.join(config.localProjectsRoot, projectID)

  const starting = new Map<string, Promise<VmAddress>>()

  // One start per VM at a time: two at once would race for the same port.
  function start(spec: VmSpec & { port: number }): Promise<VmAddress> {
    const existing = running.get(spec.projectID)
    if (existing) return Promise.resolve(existing.address)
    const pending = starting.get(spec.projectID)
    if (pending) return pending
    const started = launch(spec).finally(() => starting.delete(spec.projectID))
    starting.set(spec.projectID, started)
    return started
  }

  async function launch(spec: VmSpec & { port: number }): Promise<VmAddress> {
    const home = path.join(dir(spec.projectID), "home")
    await mkdir(home, { recursive: true })
    const port = spec.port
    // A control plane that crashed leaves its servers running on their ports; stop ours before starting again.
    if (!(await portFree(port))) await stopLeftover(path.join(dir(spec.projectID), "vm.pid"), port)
    if (!(await portFree(port))) throw new Error(`Port ${port} of VM ${spec.projectID} is taken by another process`)
    const log = createWriteStream(path.join(dir(spec.projectID), "vm.log"), { flags: "a" })
    const command = config.localServeCommand
    const child = spawn(
      command[0]!,
      [...command.slice(1), "--hostname", config.fixedUrl ? "0.0.0.0" : "127.0.0.1", "--port", String(port), "--cors", config.appOrigin],
      {
        cwd: home,
        // Allowlisted: nothing from the control plane's own environment reaches the VM.
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, OMAI_PROJECTS_HOME: home, ...spec.env },
        stdio: ["ignore", "pipe", "pipe"],
      },
    )
    child.stdout?.pipe(log)
    child.stderr?.pipe(log)
    if (child.pid !== undefined) await writeFile(path.join(dir(spec.projectID), "vm.pid"), String(child.pid))
    const address = { vmID: spec.projectID, host: config.fixedUrl ?? `http://127.0.0.1:${port}`, home }
    running.set(spec.projectID, { child, address })
    child.on("exit", () => {
      if (running.get(spec.projectID)?.child === child) running.delete(spec.projectID)
    })
    return address
  }

  return {
    async create(spec) {
      await mkdir(dir(spec.projectID), { recursive: true })
      // A retried create keeps the port it was given the first time.
      const saved = await readSpec(spec.projectID)
      const full = { ...spec, port: fixedPort ?? saved?.port ?? (await freePort()) }
      await writeFile(path.join(dir(spec.projectID), "spec.json"), JSON.stringify(full), { mode: 0o600 })
      return start(full)
    },

    async ensureRunning(vmID) {
      const existing = running.get(vmID)
      if (existing) return existing.address
      const spec = await readSpec(vmID)
      if (!spec) throw new Error(`No saved spec for VM ${vmID}`)
      if (fixedPort !== undefined) return start({ ...spec, port: fixedPort })
      if (spec.port !== undefined) return start({ ...spec, port: spec.port })
      const full = { ...spec, port: await freePort() }
      await writeFile(path.join(dir(vmID), "spec.json"), JSON.stringify(full), { mode: 0o600 })
      return start(full)
    },

    async stop(vmID) {
      const entry = running.get(vmID)
      running.delete(vmID)
      if (entry) await kill(entry.child)
    },

    async list() {
      return [...running.keys()]
    },

    /** Stops every process this provider started. */
    async close() {
      const children = [...running.values()].map((entry) => entry.child)
      running.clear()
      await Promise.all(children.map(kill))
    },
  } satisfies VmProvider & { close(): Promise<void> }

  async function readSpec(projectID: string) {
    const text = await readFile(path.join(dir(projectID), "spec.json"), "utf8").catch(() => undefined)
    if (text === undefined) return undefined
    return Option.getOrThrowWith(decodeSpec(text), () => new Error(`Invalid saved spec for VM ${projectID}`))
  }
}

/** SIGTERM, then SIGKILL after 10 s; resolves once the process has exited. */
function kill(child: ChildProcess) {
  return new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve()
    const timer = setTimeout(() => child.kill("SIGKILL"), 10_000)
    child.once("exit", () => {
      clearTimeout(timer)
      resolve()
    })
    child.kill("SIGTERM")
  })
}

/**
 * Stops the server a previous control plane started for this VM, found by the pid it saved. Only a process whose
 * command line still names this port is stopped, so a reused pid never takes another program down.
 */
async function stopLeftover(pidFile: string, port: number) {
  const pid = Number(await readFile(pidFile, "utf8").catch(() => ""))
  if (!Number.isInteger(pid) || pid <= 0) return
  const command = await new Promise<string>((resolve) =>
    execFile("ps", ["-p", String(pid), "-o", "command="], (error, stdout) => resolve(error ? "" : stdout)),
  )
  if (!command.includes(`--port ${port}`)) return
  console.log(`stopping the server left on port ${port} (pid ${pid})`)
  const deadline = Date.now() + 10_000
  process.kill(pid, "SIGTERM")
  while (!(await portFree(port)) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100))
  if (!(await portFree(port))) process.kill(pid, "SIGKILL")
  while (!(await portFree(port)) && Date.now() < deadline + 2_000)
    await new Promise((resolve) => setTimeout(resolve, 100))
}

function portFree(port: number) {
  return new Promise<boolean>((resolve) => {
    const server = createServer()
    server.once("error", () => resolve(false))
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)))
  })
}

function freePort() {
  return new Promise<number>((resolve, reject) => {
    const server = createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      const port = typeof address === "object" && address ? address.port : 0
      server.close(() => resolve(port))
    })
  })
}
