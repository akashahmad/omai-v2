// Which ports a dev server opened. The process tree's listening sockets are the truth; ports in its log are a hint.

import { execFile } from "node:child_process"
import { readdir, readFile, readlink } from "node:fs/promises"
import { createServer } from "node:net"

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g

const LOCAL_URL = /(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]):(\d{2,5})/g

/** Ports a log mentions on a local address, in order, without colour codes, privileged ports or repeats. */
export function logPorts(text: string): number[] {
  const ports = [...text.replace(ANSI, "").matchAll(LOCAL_URL)]
    .map((match) => Number(match[1]))
    .filter((port) => port >= 1024 && port <= 65535)

  return [...new Set(ports)]
}

/** Every TCP port a process or any of its descendants is listening on. */
export async function listeningPorts(rootPid: number): Promise<number[]> {
  const pids = await tree(rootPid)

  if (pids.length === 0) return []

  return process.platform === "linux" ? linuxPorts(pids) : lsofPorts(pids)
}

function exec(file: string, args: string[]) {
  return new Promise<string>((resolve) =>
    execFile(file, args, { timeout: 2_000 }, (_, stdout) => resolve(typeof stdout === "string" ? stdout : "")),
  )
}

// The process and its descendants, from one `ps` listing of every process's parent.
async function tree(rootPid: number) {
  const children = new Map<number, number[]>()
  ;(await exec("ps", ["-A", "-o", "pid=,ppid="]))
    .split("\n")
    .map((line) => line.trim().split(/\s+/).map(Number))
    .filter((pair) => pair.length === 2 && pair.every(Number.isFinite))
    .forEach(([pid, ppid]) => children.set(ppid!, [...(children.get(ppid!) ?? []), pid!]))

  const found: number[] = []
  const queue = [rootPid]

  for (let pid = queue.shift(); pid !== undefined; pid = queue.shift()) {
    found.push(pid)
    queue.push(...(children.get(pid) ?? []))
  }

  return found
}

async function lsofPorts(pids: number[]) {
  const out = await exec("lsof", ["-nP", "-a", "-iTCP", "-sTCP:LISTEN", "-p", pids.join(",")])
  const ports = [...out.matchAll(/:(\d+) \(LISTEN\)/g)].map((match) => Number(match[1]))

  return [...new Set(ports)]
}

// Linux has no lsof everywhere: match the sockets each process holds against the kernel's listening table.
async function linuxPorts(pids: number[]) {
  const inodes = new Set(
    (
      await Promise.all(
        pids.map(async (pid) => {
          const fds = await readdir(`/proc/${pid}/fd`).catch(() => [] as string[])
          const links = await Promise.all(fds.map((fd) => readlink(`/proc/${pid}/fd/${fd}`).catch(() => "")))

          return links.flatMap((link) => /^socket:\[(\d+)\]$/.exec(link)?.[1] ?? [])
        }),
      )
    ).flat(),
  )
  const tables = await Promise.all(
    ["/proc/net/tcp", "/proc/net/tcp6"].map((file) => readFile(file, "utf8").catch(() => "")),
  )
  const ports = tables
    .flatMap((table) => table.split("\n").slice(1))
    .map((line) => line.trim().split(/\s+/))
    // Columns: sl, local_address (hex ip:port), rem_address, st (0A is LISTEN), ..., inode at index 9.
    .filter((cols) => cols[3] === "0A" && inodes.has(cols[9] ?? ""))
    .map((cols) => parseInt(cols[1]!.split(":")[1]!, 16))

  return [...new Set(ports)]
}

/** A TCP port that is free on loopback right now. */
export function freePort() {
  return new Promise<number>((resolve, reject) => {
    const server = createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      server.close(() => resolve(typeof address === "object" && address ? address.port : 0))
    })
  })
}
