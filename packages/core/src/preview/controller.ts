// One project's preview: picks the recipe, installs, starts, watches and stops the dev server, and keeps the preview
// listener in front of it. Plain Node so it can be tested on its own; the plugin adapts it to the RPC.

import { createHash, randomBytes } from "node:crypto"
import { accessSync, constants, watch, type FSWatcher } from "node:fs"
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import type { Preview } from "@opencode/schema/preview"
import { bridgeScript } from "./bridge.js"
import { captureSchedule } from "./schedule.js"
import { visualScript } from "./visual.js"
import { detect, packageManager, type Tree } from "./detect.js"
import { fingerprint, install, installCommand, needsInstall } from "./install.js"
import { CRASH_WINDOW, IDLE_STOP } from "./limits.js"
import { freePort } from "./ports.js"
import { ProjectVmBusy } from "../project-vm/busy.js"
import { LogBuffer, spawnGroup, waitReady, type Running } from "./process.js"
import { openProxy, type Proxy, type Upstream } from "./proxy.js"
import { staticSite, type StaticSite } from "./static.js"

type Recipe = Preview.Recipe

type Status = Preview.Status

export interface Store {
  get(key: string): Promise<unknown>
  /** `undefined` removes the key. */
  set(key: string, value: unknown): Promise<void>
}

export interface Failure {
  step: "detect" | "install" | "start" | "crash"
  reason: string
  log: string
  sessionID?: string
}

export type Attempt = { ok: true } | { ok: false; reason: string; log: string }

/** Tries recipes until one runs: the AI fallback. It runs each through `attempt`, which installs and starts it. */
export type Fix = (
  failure: Failure,
  attempt: (recipe: Recipe) => Promise<Attempt>,
  /** Stops an attempt that is still installing or starting. */
  cancel: () => Promise<void>,
) => Promise<{ recipe: Recipe } | { reason: string }>

export interface ControllerInput {
  directory: string
  hostname: string
  store: Store
  config: () => Recipe | undefined
  emit: { changed(status: Status): void; log(chunk: string): void }
  fix?: Fix
  /** Whether the preview listener asks for a ticket. */
  auth?: boolean
  /** A port the preview listener always uses (a VM's published port), instead of a saved or free one. */
  port?: number
  /** The preview's public origin, once known (a VM's); the status carries it so the app loads the preview there. */
  origin?: () => string | undefined
  /** The environment dev servers start from; the process's own by default. */
  env?: Record<string, string>
  /** `captureDelay` and `captureInterval` time the thumbnail captures, in milliseconds. */
  limits?: { idle?: number; crashWindow?: number; captureDelay?: number; captureInterval?: number }
  /**
   * Takes and keeps a screenshot of the running app at `url` (the dev server itself), for the projects page. Called a
   * few seconds after the preview comes up or changes, at most once per interval; a rejection keeps the last one.
   */
  thumbnail?: { capture(url: string): Promise<void> }
}

export interface Controller {
  status(): Status
  start(choice?: { candidate?: number; sessionID?: string; retry?: boolean }): Promise<Status>
  stop(): Promise<Status>
  restart(): Promise<Status>
  setRecipe(recipe: Recipe | null): Promise<Status>
  logs(): string
  ticket(): string
  /** Marks the preview as on screen; a preview nobody marks for the idle limit stops. */
  watch(): void
  /** The dev server's own port while the preview runs, for tools that measure the app without the proxy. */
  upstream(): number | undefined
  /**
   * Saves an image the visual editor uploads into the running app's public folder (the site root for a static site),
   * under `images/`, and returns its address on the site and its path in the project. Rejects other file types,
   * files over 8 MB, and a preview that isn't set up yet.
   */
  asset(input: { name: string; base64: string }): Promise<{ url: string; path: string }>
  close(): Promise<void>
}

// A ticket is single-use; this only bounds how long an unused one stays valid, as for a frame that loads late.
const TICKET_TTL = 10 * 60_000

// A thumbnail waits for the page to settle after a change, and is retaken at most this often.
const CAPTURE_DELAY = 4_000
const CAPTURE_INTERVAL = 3 * 60_000

const ASSET_LIMIT = 8 * 1024 * 1024

const ASSET_TYPES = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".svg"])

export function createController(input: ControllerInput): Controller {
  const idle = input.limits?.idle ?? IDLE_STOP
  const crashWindow = input.limits?.crashWindow ?? CRASH_WINDOW
  const baseEnv = input.env ?? (process.env as Record<string, string>)
  const log = new LogBuffer()
  const reloads = new Set<(event: string) => void>()
  const tickets = new Map<string, number>()
  const thumbnail = input.thumbnail
  const capture = captureSchedule({
    delay: input.limits?.captureDelay ?? CAPTURE_DELAY,
    interval: input.limits?.captureInterval ?? CAPTURE_INTERVAL,
    run: async () => {
      if (!thumbnail || state.status.state !== "running" || state.upstream.kind !== "port") return
      await thumbnail.capture(`http://127.0.0.1:${state.upstream.port}/`)
    },
  })
  // Images the visual editor uploaded, by the path the page loads them from; the proxy serves them itself.
  const uploads = new Map<string, string>()
  // The preview cookie's value. Kept with the project, so a browser that entered the preview stays in after the
  // server restarts (as a VM does on resume); a fresh one is made only the first time.
  const secret = { value: "" }

  const state: {
    status: Status
    candidates?: Preview.Candidate[]
    proxy?: Proxy
    upstream: Upstream
    process?: Running
    site?: StaticSite
    watchers: FSWatcher[]
    run?: Promise<Status>
    abort?: AbortController
    lastCrash?: number
    lastWatch: number
    closed: boolean
    /** The detected framework, kept across the states of one start. */
    framework?: string
  } = { status: { state: "idle" }, upstream: { kind: "down" }, watchers: [], lastWatch: Date.now(), closed: false }

  // What the app sees. On a VM the preview is reached only at its public origin: until that is known there is no port
  // either, or the app would load the preview on the server's own host.
  const published = (): Status => {
    const origin = input.origin?.()
    if (input.origin && !origin) return { ...state.status, port: undefined }
    return { ...state.status, origin }
  }

  const set = (next: Partial<Status> & Pick<Status, "state">) => {
    // The idle clock starts when the preview comes up, not when a long install began.
    if (next.state === "running") state.lastWatch = Date.now()

    if (next.state === "running") capture.poke()
    state.status = {
      ...next,
      framework: next.framework ?? state.framework,
      port: state.proxy?.port,
      auth: input.auth || undefined,
    }
    input.emit.changed(published())

    return published()
  }

  const onLog = (chunk: string) => {
    log.append(chunk)
    input.emit.log(chunk)
  }

  // One listener for the life of the controller, opened by the first start; two starts at once share it. It never
  // opens up front: a VM's server keeps a preview per folder, all on one published port, and only one that starts may
  // take it.
  const opening: { current?: Promise<Proxy> } = {}
  const proxy = () => {
    opening.current ??= openListener().catch((error: unknown) => {
      opening.current = undefined
      throw error
    })
    return opening.current
  }

  const openListener = async () => {
    secret.value = await loadSecret(input.store)
    const saved = input.port ?? (await input.store.get("port"))
    const open = (port: number) =>
      openProxy({
        hostname: input.hostname,
        port,
        upstream: () => state.upstream,
        auth: input.auth
          ? {
              verify: (value) => !!value && value === secret.value,
              exchange: (ticket) => {
                const expires = tickets.get(ticket)
                tickets.delete(ticket)

                return expires !== undefined && expires > Date.now() ? secret.value : undefined
              },
            }
          : undefined,
        bridge: bridgeScript,
        visual: visualScript,
        uploads: (pathname) => uploads.get(pathname),
        crossSite: input.origin !== undefined,
        events: {
          subscribe: (listener) => {
            reloads.add(listener)
            return () => reloads.delete(listener)
          },
        },
      })
    // A fixed port has no fallback: anything else would not be the port the VM publishes.
    const opened =
      input.port !== undefined
        ? await open(input.port)
        : typeof saved === "number"
          ? await open(saved).catch(() => open(0))
          : await open(0)

    if (input.port === undefined && opened.port !== saved) await input.store.set("port", opened.port)
    state.proxy = opened

    return opened
  }

  const tree = directoryTree(input.directory)

  // Stops whatever runs now: the dev server, the static site and the file watchers.
  const halt = async () => {
    state.abort?.abort()
    state.watchers.splice(0).forEach((watcher) => watcher.close())
    state.upstream = { kind: "down" }
    const running = state.process
    state.process = undefined
    await running?.stop()
    await state.site?.close()
    state.site = undefined
  }

  /** Installs and starts `recipe`, leaving it running on success. */
  const attempt = async (recipe: Recipe, quiet = false): Promise<Attempt> => {
    await halt()
    await proxy()
    const abort = new AbortController()
    state.abort = abort
    const root = path.resolve(input.directory, recipe.root)
    const show = (next: Preview.State) => (quiet ? undefined : set({ state: next, recipe }))

    if (recipe.kind === "static") {
      const site = await staticSite(root).catch(() => undefined)

      if (!site) return { ok: false, reason: `${recipe.root} can't be served.`, log: "" }
      state.site = site
      site.onChange(() => {
        reloads.forEach((listener) => listener("reload"))
        capture.poke()
      })
      state.upstream = { kind: "port", port: site.port }

      return { ok: true }
    }
    const installRoot = await findInstallRoot(input.directory, root)

    if (installRoot) {
      const current = await fingerprint(installRoot)

      if (recipe.install || (await needsInstall(installRoot, current))) {
        show("installing")
        const pm = await packageManager(tree, relative(input.directory, installRoot))
        const chosen = installCommand(pm, (bin) => available(bin, baseEnv.PATH))

        if (chosen.note) onLog(`${chosen.note}\n`)
        const command = recipe.install ?? chosen.command
        onLog(`$ ${command}\n`)
        const installed = await install({
          root: installRoot,
          command,
          retry: recipe.install ?? chosen.retry,
          env: { ...scrub(baseEnv), ...chosen.env, CI: "1" },
          onLog,
          signal: abort.signal,
        })

        if (!installed.ok) return installed
      }
    }

    if (!recipe.command) return { ok: false, reason: "The recipe has no start command.", log: log.tail(4096) }
    show("starting")
    const assigned = recipe.port ?? (await freePort())
    const command = recipe.command.replaceAll("{port}", String(assigned))
    onLog(`$ ${command}\n`)
    const running = spawnGroup({
      command,
      cwd: root,
      env: devEnv(baseEnv, input.directory, root, assigned),
      onLog,
    })
    state.process = running
    const ready = await waitReady({ running, assigned, log: () => log.text(), signal: abort.signal })

    if (!ready.ok) {
      await halt()

      return { ok: false, reason: ready.reason, log: log.tail(4096) }
    }
    state.upstream = { kind: "port", port: ready.port }
    reloads.forEach((listener) => listener("reload"))
    void running.exited.then(() => {
      if (state.process === running) void crashed(recipe)
    })
    if (installRoot) follow(installRoot, recipe)

    return { ok: true }
  }

  const crashed = async (recipe: Recipe) => {
    state.process = undefined
    state.upstream = { kind: "down" }
    const now = Date.now()

    if (state.lastCrash !== undefined && now - state.lastCrash < crashWindow) {
      set({ state: "failed", recipe, reason: "The dev server crashed. Check the log for the error." })
      return
    }
    state.lastCrash = now
    onLog("\nThe dev server stopped unexpectedly. Restarting it.\n")
    await launch(recipe)
  }

  // A package.json or lockfile change while running reinstalls and restarts.
  const follow = (installRoot: string, recipe: Recipe) => {
    const known = { value: "" }
    void fingerprint(installRoot).then((value) => (known.value = value))
    const timer: { current?: ReturnType<typeof setTimeout> } = {}
    const check = () => {
      clearTimeout(timer.current)
      timer.current = setTimeout(async () => {
        const next = await fingerprint(installRoot)

        if (next === known.value || state.status.state !== "running") return
        known.value = next
        onLog("\nThe project's packages changed. Reinstalling.\n")
        await launch(recipe)
      }, 300)
    }
    const watcher = (() => {
      try {
        return watch(installRoot, (_, file) => {
          if (file && (file === "package.json" || LOCKFILES.includes(String(file)))) check()
        })
      } catch {
        return undefined
      }
    })()

    if (watcher) state.watchers.push(watcher)
  }

  // Runs one recipe to the end and reports it; a failure goes to the AI when there is one.
  const launch = async (recipe: Recipe, sessionID?: string, retry = false): Promise<Status> => {
    const result = await attempt(recipe)

    if (state.closed) return state.status

    if (result.ok) {
      if (recipe.source !== "config") await input.store.set("recipe", recipe)

      return set({ state: "running", recipe })
    }

    return fail({ step: "start", reason: result.reason, log: result.log, sessionID }, recipe, retry)
  }

  const fail = async (failure: Failure, recipe: Recipe | undefined, retry: boolean): Promise<Status> => {
    const key = await projectKey(tree)

    if (!input.fix || (!retry && (await input.store.get("fixed")) === key))
      return set({ state: "failed", recipe, reason: failure.reason })
    await input.store.set("fixed", key)
    const startedAt = Date.now()
    const tries = { count: 0 }
    set({ state: "fixing", recipe, fixing: { tries: 0, startedAt } })
    const outcome = await input.fix(
      failure,
      async (next) => {
        tries.count++
        set({ state: "fixing", recipe: next, fixing: { tries: tries.count, startedAt } })

        return attempt(next, true)
      },
      halt,
    )

    if (state.closed) return state.status

    if ("recipe" in outcome) {
      const saved = { ...outcome.recipe, source: "ai" as const }
      await input.store.set("recipe", saved)

      return set({ state: "running", recipe: saved })
    }
    await halt()

    return set({ state: "failed", recipe, reason: outcome.reason })
  }

  const run = async (choice: { candidate?: number; sessionID?: string; retry?: boolean }): Promise<Status> => {
    state.lastWatch = Date.now()
    const picked = choice.candidate === undefined ? undefined : state.candidates?.[choice.candidate]

    if (picked) return launch({ ...picked.recipe, source: "picked" }, choice.sessionID, choice.retry)
    const saved = decodeRecipe(await input.store.get("recipe"))
    // A saved recipe whose folder or page is gone, as after files move, is detected again rather than served empty.
    const known = input.config() ?? (saved && (await usable(input.directory, saved)) ? saved : undefined)

    if (known) return launch(known, choice.sessionID, choice.retry)

    if (saved) await input.store.set("recipe", undefined)
    set({ state: "detecting" })
    const candidates = await detect(tree)
    state.candidates = candidates
    const [first] = candidates

    if (!first && (await blank(input.directory))) return wait()

    if (!first)
      return fail(
        {
          step: "detect",
          reason: "No web app or site was found in this project.",
          log: log.tail(4096),
          sessionID: choice.sessionID,
        },
        undefined,
        !!choice.retry,
      )

    // Several apps that look equally likely: the first one starts, never a question to the user.
    state.framework = first.framework

    return launch(first.recipe, choice.sessionID, choice.retry)
  }

  // Nothing to preview yet: the panel shows the bare logo, and the preview starts once files appear, as when the agent
  // writes the site.
  const wait = () => {
    const timer: { current?: ReturnType<typeof setTimeout> } = {}
    const watcher = (() => {
      try {
        return watch(input.directory, () => {
          clearTimeout(timer.current)
          timer.current = setTimeout(() => {
            if (state.status.state === "empty") void start()
          }, 300)
        })
      } catch {
        return undefined
      }
    })()

    if (watcher) state.watchers.push(watcher)

    return set({ state: "empty" })
  }

  // A single flight: a second start while one is running joins it.
  const start = (choice: { candidate?: number; sessionID?: string; retry?: boolean } = {}) => {
    if (state.run) return state.run
    // Detecting, installing and starting keep a MicroVM from pausing.
    const release = ProjectVmBusy.hold("install")
    state.run = run(choice).finally(() => {
      release()
      state.run = undefined
    })

    return state.run
  }

  const stop = async () => {
    await halt()

    return set({ state: "stopped", recipe: state.status.recipe })
  }

  const timer = setInterval(
    () => {
      if (state.status.state === "running" && Date.now() - state.lastWatch > idle) void stop()
    },
    Math.max(50, Math.min(60_000, idle / 4)),
  )

  return {
    status: () => published(),
    start,
    stop,
    restart: async () => {
      const recipe = state.status.recipe
      await halt()

      // The project may have changed since it started, such as its app being removed; then it is detected again.
      return recipe && (await usable(input.directory, recipe)) ? launch(recipe) : start()
    },
    setRecipe: async (recipe) => {
      await input.store.set("recipe", recipe ? { ...recipe, source: "user" } : undefined)
      await halt()
      state.candidates = undefined

      return start({ retry: true })
    },
    logs: () => log.text(),
    ticket: () => {
      const ticket = randomBytes(24).toString("hex")
      tickets.set(ticket, Date.now() + TICKET_TTL)

      return ticket
    },
    watch: () => {
      state.lastWatch = Date.now()
      // A preview on screen may have changed (hot reload); the schedule keeps this to one capture per interval.
      capture.poke()
    },
    upstream: () =>
      state.status.state === "running" && state.upstream.kind === "port" ? state.upstream.port : undefined,
    asset: async (asset) => {
      const recipe = state.status.recipe

      if (!recipe) throw new Error("Start the preview before adding images.")
      const name = assetName(asset.name)
      const bytes = Buffer.from(asset.base64, "base64")

      if (bytes.length > ASSET_LIMIT) throw new Error("Images can be at most 8 MB.")
      const root = path.resolve(input.directory, recipe.root)
      // Vite, Next.js, Astro and Create React App all serve `public/` at the site root; a static site is its own root.
      const served = recipe.kind === "static" ? root : path.join(root, "public")
      const folder = path.join(served, "images")
      await mkdir(folder, { recursive: true })
      const file = await freeName(folder, name)
      await writeFile(path.join(folder, file), bytes)
      uploads.set(`/images/${file}`, path.join(folder, file))

      return { url: `/images/${file}`, path: path.relative(input.directory, path.join(folder, file)) }
    },
    close: async () => {
      state.closed = true
      capture.stop()
      clearInterval(timer)
      await halt()
      await opening.current?.catch(() => undefined)
      await state.proxy?.close()
      state.proxy = undefined
      opening.current = undefined
    },
  }
}

const LOCKFILES = ["bun.lock", "bun.lockb", "pnpm-lock.yaml", "yarn.lock", "package-lock.json"]

// Where packages install: the nearest directory from the app up to the project that has a lockfile or declares
// workspaces, else the app's own directory when it has a package.json.
async function findInstallRoot(directory: string, root: string) {
  const own = await readFile(path.join(root, "package.json"), "utf8").catch(() => undefined)

  for (let dir = root; ; dir = path.dirname(dir)) {
    const names = new Set(await readdir(dir).catch(() => [] as string[]))

    if (LOCKFILES.some((file) => names.has(file))) return dir
    const pkg = await readFile(path.join(dir, "package.json"), "utf8").catch(() => undefined)

    if (pkg && (names.has("pnpm-workspace.yaml") || /"workspaces"\s*:/.test(pkg))) return dir

    if (dir === directory || path.dirname(dir) === dir) break
  }

  return own === undefined ? undefined : root
}

// Variables a dev server must not see: the server's own settings, and the markers coding agents set. Astro and others
// detect an agent from these and move their dev server into the background, where the preview can't follow it.
const HIDDEN =
  /^(OMAI_|OPENCODE|CLAUDECODE$|CLAUDE_CODE_|CODEX_|CURSOR_TRACE_ID$|CURSOR_AGENT$|AMP_|AUGMENT_AGENT$|ANTIGRAVITY_|GEMINI_CLI$|QWEN_CODE$|PI_CODING_AGENT$|CRUSH$|AI_AGENT$|AGENT$|REPL_ID$|REPLIT_MODE$)/

/** The base environment without the variables a project's own code must not see. */
const scrub = (base: Record<string, string>) =>
  Object.fromEntries(Object.entries(base).filter(([name]) => !HIDDEN.test(name)))

/**
 * The environment a dev server starts with: the base without hidden variables, every node_modules/.bin from the app
 * up to the project, nearest first so local CLIs win over global ones, and the preview's port and host.
 */
export function devEnv(
  base: Record<string, string>,
  directory: string,
  root: string,
  port: number,
): Record<string, string> {
  const bins: string[] = []

  for (let dir = root; ; dir = path.dirname(dir)) {
    bins.push(path.join(dir, "node_modules", ".bin"))

    if (dir === directory || path.dirname(dir) === dir) break
  }
  const visible = scrub(base)

  return {
    ...visible,
    PATH: [...bins, base.PATH ?? ""].join(path.delimiter),
    PORT: String(port),
    HOST: "127.0.0.1",
    BROWSER: "none",
    WDS_SOCKET_PORT: "0",
    NEXT_TELEMETRY_DISABLED: "1",
    NUXT_TELEMETRY_DISABLED: "1",
    ASTRO_TELEMETRY_DISABLED: "1",
    GATSBY_TELEMETRY_DISABLED: "1",
    NG_CLI_ANALYTICS: "false",
    FORCE_COLOR: "1",
  }
}

function available(bin: string, searchPath: string | undefined) {
  return (searchPath ?? "").split(path.delimiter).some((dir) => {
    try {
      accessSync(path.join(dir, bin), constants.X_OK)
      return true
    } catch {
      return false
    }
  })
}

/** A `Tree` over a real directory. */
export function directoryTree(directory: string): Tree {
  return {
    read: (file) => readFile(path.join(directory, file), "utf8").catch(() => undefined),
    list: async (dir) =>
      (await readdir(path.join(directory, dir), { withFileTypes: true }).catch(() => [])).map((entry) => ({
        name: entry.name,
        dir: entry.isDirectory(),
      })),
  }
}

// What the AI fallback last saw of the project: its package.json files and whether it has an index.html. The fallback
// runs again only once this changes, so reopening the preview doesn't spend tokens on the same failure.
async function projectKey(tree: Tree) {
  const hash = createHash("sha256")
  const queue = [{ dir: ".", depth: 0 }]

  for (let next = queue.shift(); next; next = queue.shift()) {
    const entries = await tree.list(next.dir)

    for (const entry of entries) {
      const file = next.dir === "." ? entry.name : `${next.dir}/${entry.name}`

      if (!entry.dir && (entry.name === "package.json" || entry.name === "index.html")) {
        hash.update(file)
        hash.update((await tree.read(file)) ?? "")
      }

      if (entry.dir && next.depth < 3 && entry.name !== "node_modules" && !entry.name.startsWith("."))
        queue.push({ dir: file, depth: next.depth + 1 })
    }
  }

  return hash.digest("hex")
}

function decodeRecipe(value: unknown): Recipe | undefined {
  if (!value || typeof value !== "object") return undefined
  const recipe = value as Partial<Recipe>

  return typeof recipe.root === "string" && (recipe.kind === "static" || recipe.kind === "command")
    ? (recipe as Recipe)
    : undefined
}

const relative = (directory: string, target: string) => path.relative(directory, target) || "."

// Whether a saved recipe still has something to run: its folder with files of its own, and for a static site its
// page. A dev server in a folder whose app was removed answers every page with an empty 404, a blank preview.
async function loadSecret(store: Store) {
  const saved = await store.get("secret")

  if (typeof saved === "string" && /^[0-9a-f]{48}$/.test(saved)) return saved
  const fresh = randomBytes(24).toString("hex")
  await store.set("secret", fresh)

  return fresh
}

async function usable(directory: string, recipe: Recipe) {
  const root = path.resolve(directory, recipe.root)
  const folder = await stat(root).catch(() => undefined)

  if (!folder?.isDirectory() || (await blank(root))) return false

  if (recipe.kind !== "static") return true

  return (await stat(path.join(root, "index.html")).catch(() => undefined))?.isFile() === true
}

// Whether the project has no files of its own yet; hidden files such as .git don't count.
async function blank(directory: string) {
  const entries = await readdir(directory).catch(() => [] as string[])

  return entries.every((name) => name.startsWith("."))
}

// An uploaded file's name made safe for the images folder: no folders, only plain characters, an image extension.
function assetName(input: string) {
  const base = path.basename(input.replaceAll("\\", "/"))
  const extension = path.extname(base).toLowerCase()

  if (!ASSET_TYPES.has(extension)) throw new Error("Only PNG, JPEG, GIF, WebP, AVIF and SVG images can be added.")
  const stem = base.slice(0, -extension.length).replace(/[^\w.-]+/g, "-").replace(/^[.-]+/, "") || "image"

  return `${stem}${extension}`
}

// `name`, or `name-1`, `name-2`… when a file of that name is already in the folder.
async function freeName(folder: string, name: string) {
  const extension = path.extname(name)
  const stem = name.slice(0, -extension.length)
  const taken = new Set(await readdir(folder).catch(() => [] as string[]))

  for (let index = 0; ; index++) {
    const candidate = index === 0 ? name : `${stem}-${index}${extension}`

    if (!taken.has(candidate)) return candidate
  }
}

