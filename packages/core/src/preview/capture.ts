// Screenshots a page with the Chrome the machine already has, for the projects page's preview thumbnails. It talks to
// Chrome over the DevTools protocol directly, so the server needs no browser library: open a desktop-sized page, wait
// for it to load and settle, and let Chrome encode a half-size WebP. One short-lived Chrome per capture.

import { spawn, type ChildProcess } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

const WIDTH = 1280
const HEIGHT = 800
const SCALE = 0.5
const QUALITY = 72
const TIMEOUT = 45_000
const LOAD_TIMEOUT = 15_000
// Web fonts, images and entrance animations usually land within this after the load event.
const SETTLE = 1_200

type Reply = { id?: number; method?: string; sessionId?: string; result?: Record<string, unknown>; error?: { message: string } }

/** A WebP screenshot of the top of `url` in a 1280×800 window, at half size (640×400). Rejects when it can't load. */
export async function capturePage(input: { chrome: string; url: string }): Promise<Uint8Array> {
  const dir = await mkdtemp(path.join(tmpdir(), "omai-capture-"))
  const child = spawn(input.chrome, chromeArgs(dir), { stdio: ["ignore", "ignore", "pipe"] })
  const timer = { id: undefined as ReturnType<typeof setTimeout> | undefined }

  try {
    const work = endpoint(child).then((url) => screenshot(url, input.url))
    const limit = new Promise<never>((_, reject) => {
      timer.id = setTimeout(() => reject(new Error("The screenshot took too long.")), TIMEOUT)
    })

    return await Promise.race([work, limit])
  } finally {
    clearTimeout(timer.id)
    await stop(child)
    await rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
}

// Chrome keeps writing its profile until it has exited, so the profile is removed only after that.
function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()

  return new Promise<void>((resolve) => {
    const done = setTimeout(resolve, 3_000)
    child.once("exit", () => {
      clearTimeout(done)
      resolve()
    })
    child.kill("SIGKILL")
  })
}

function chromeArgs(dir: string) {
  return [
    "--headless=new",
    "--disable-gpu",
    "--no-sandbox",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-background-networking",
    "--hide-scrollbars",
    "--mute-audio",
    "--remote-debugging-port=0",
    `--user-data-dir=${path.join(dir, "profile")}`,
    "about:blank",
  ]
}

// Chrome prints its DevTools address on stderr once it listens.
function endpoint(child: ChildProcess) {
  return new Promise<string>((resolve, reject) => {
    const seen = { text: "" }
    child.stderr?.on("data", (chunk: Buffer) => {
      seen.text = (seen.text + chunk.toString()).slice(-8192)
      const match = /DevTools listening on (ws:\/\/\S+)/.exec(seen.text)

      if (match?.[1]) resolve(match[1])
    })
    child.once("error", () => reject(new Error("Chrome could not start.")))
    child.once("exit", () => reject(new Error("Chrome exited before it was ready.")))
  })
}

async function screenshot(browserUrl: string, pageUrl: string) {
  const cdp = await connect(browserUrl)

  try {
    const target = await cdp.send("Target.createTarget", { url: "about:blank" })
    const attached = await cdp.send("Target.attachToTarget", { targetId: target.targetId, flatten: true })
    const session = String(attached.sessionId)
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false }, session)
    await cdp.send("Page.enable", {}, session)
    // A page that never fires load (a stuck request) is still worth a picture of what did render.
    const loaded = cdp.once("Page.loadEventFired", session, LOAD_TIMEOUT).catch(() => undefined)
    const navigated = await cdp.send("Page.navigate", { url: pageUrl }, session)

    if (typeof navigated.errorText === "string" && navigated.errorText)
      throw new Error(`The page could not load: ${navigated.errorText}`)
    await loaded
    await new Promise((resolve) => setTimeout(resolve, SETTLE))
    const shot = await cdp.send(
      "Page.captureScreenshot",
      { format: "webp", quality: QUALITY, clip: { x: 0, y: 0, width: WIDTH, height: HEIGHT, scale: SCALE } },
      session,
    )

    if (typeof shot.data !== "string") throw new Error("Chrome returned no screenshot.")

    return new Uint8Array(Buffer.from(shot.data, "base64"))
  } finally {
    cdp.close()
  }
}

// A minimal DevTools protocol client: numbered requests and their replies, plus one-off event waits.
async function connect(url: string) {
  const socket = new WebSocket(url)
  const pending = new Map<number, { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }>()
  const waiters = new Set<{ method: string; session: string; resolve: () => void }>()
  const counter = { next: 1 }

  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true })
    socket.addEventListener("error", () => reject(new Error("Could not reach Chrome.")), { once: true })
  })

  socket.addEventListener("message", (event: MessageEvent<string>) => {
    const reply = JSON.parse(String(event.data)) as Reply

    if (reply.id !== undefined) {
      const request = pending.get(reply.id)
      pending.delete(reply.id)

      if (reply.error) request?.reject(new Error(reply.error.message))
      else request?.resolve(reply.result ?? {})

      return
    }

    waiters.forEach((waiter) => {
      if (waiter.method !== reply.method || waiter.session !== reply.sessionId) return
      waiters.delete(waiter)
      waiter.resolve()
    })
  })

  socket.addEventListener("close", () => {
    pending.forEach((request) => request.reject(new Error("Chrome closed the connection.")))
    pending.clear()
  })

  return {
    send: (method: string, params: Record<string, unknown>, sessionId?: string) =>
      new Promise<Record<string, unknown>>((resolve, reject) => {
        const id = counter.next++
        pending.set(id, { resolve, reject })
        socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
      }),
    once: (method: string, session: string, timeout: number) =>
      new Promise<void>((resolve, reject) => {
        const waiter = { method, session, resolve }
        waiters.add(waiter)
        setTimeout(() => {
          if (!waiters.delete(waiter)) return
          reject(new Error(`${method} did not arrive.`))
        }, timeout)
      }),
    close: () => socket.close(),
  }
}
