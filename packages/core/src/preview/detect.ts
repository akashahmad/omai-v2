// Finds how to start a project's preview from its files alone. Pure: every read goes through a `Tree`, so it runs the
// same on a real directory, an uploaded zip, or a test fixture.

import type { Preview } from "@opencode/schema/preview"
import { cli, cliForBin, frameworks, type Cli, type Framework } from "./frameworks.js"

/** Read access to a project, by paths relative to its directory ("." is the directory itself). */
export interface Tree {
  read(path: string): Promise<string | undefined>
  list(dir: string): Promise<ReadonlyArray<{ readonly name: string; readonly dir: boolean }>>
}

export type PackageManager = "npm" | "pnpm" | "yarn" | "bun"

const MAX_DEPTH = 3

const SKIP = new Set(["node_modules", "dist", "build", "out", "coverage", "__MACOSX"])

// Script names that start a dev server, best first. Other names count only when they call a known dev CLI.
const DEV_NAMES = ["dev", "start", "serve", "develop"]

const LOCKFILES: ReadonlyArray<readonly [string, PackageManager]> = [
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["package-lock.json", "npm"],
]

const CONFIDENCE = { high: 0, medium: 1, low: 2 } as const

type Ranked = { candidate: Preview.Candidate; docs: boolean; name: number; depth: number }

/** Every way the project could start, best first. Empty when nothing in it looks like a web app or site. */
export async function detect(tree: Tree): Promise<Preview.Candidate[]> {
  const dirs = await walk(tree)
  const apps = (
    await Promise.all(dirs.filter((dir) => dir.files.has("package.json")).map((dir) => fromPackage(tree, dir)))
  ).flatMap((item) => (item ? [item] : []))

  if (apps.length > 0) return rank(apps)
  const site = dirs.find((dir) => dir.files.has("index.html"))

  if (!site) return []

  return [
    {
      recipe: { root: site.path, kind: "static", source: "detected" },
      framework: "static",
      confidence: "high",
      reason: `Serves ${site.path === "." ? "index.html" : `${site.path}/index.html`} as a static site`,
    },
  ]
}

/** The package manager a package root installs with: its `packageManager` field, then the nearest lockfile. */
export async function packageManager(tree: Tree, root: string): Promise<PackageManager> {
  for (const dir of ancestors(root)) {
    const declared = parse(await tree.read(join(dir, "package.json")))?.packageManager
    const named = typeof declared === "string" ? /^(npm|pnpm|yarn|bun)@/.exec(declared)?.[1] : undefined

    if (named) return named as PackageManager
    const names = new Set((await tree.list(dir)).map((entry) => entry.name))
    const lock = LOCKFILES.find(([file]) => names.has(file))

    if (lock) return lock[1]
  }

  return "npm"
}

type Dir = { path: string; depth: number; files: Set<string> }

// Breadth first, so the shallowest match comes first, down to MAX_DEPTH.
async function walk(tree: Tree) {
  const found: Dir[] = []
  const queue = [{ path: ".", depth: 0 }]

  for (let next = queue.shift(); next; next = queue.shift()) {
    const entries = await tree.list(next.path)
    found.push({ ...next, files: new Set(entries.filter((entry) => !entry.dir).map((entry) => entry.name)) })

    if (next.depth === MAX_DEPTH) continue
    const depth = next.depth + 1
    const parent = next.path
    entries
      .filter((entry) => entry.dir && !SKIP.has(entry.name) && !entry.name.startsWith("."))
      .sort((a, b) => a.name.localeCompare(b.name))
      .forEach((entry) => queue.push({ path: join(parent, entry.name), depth }))
  }

  return found
}

type Pkg = {
  scripts?: Record<string, unknown>
  dependencies?: Record<string, unknown>
  devDependencies?: Record<string, unknown>
}

async function fromPackage(tree: Tree, dir: Dir): Promise<Ranked | undefined> {
  const pkg: Pkg | undefined = parse(await tree.read(join(dir.path, "package.json")))

  if (!pkg) return undefined
  const deps = new Set([...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})])
  const framework = identify(dir.files, deps)
  const scripts = Object.fromEntries(
    Object.entries(pkg.scripts ?? {}).flatMap(([name, value]) => (typeof value === "string" ? [[name, value]] : [])),
  )
  const pm = await packageManager(tree, dir.path)
  const choice = choose(scripts, framework, pm)

  if (!choice) return undefined
  const docs = !!framework?.docs

  return {
    candidate: {
      recipe: { root: dir.path, kind: "command", command: choice.command, source: "detected" },
      framework: framework?.id ?? choice.cli?.id ?? "unknown",
      confidence: choice.confidence,
      reason: choice.reason,
    },
    docs,
    name: choice.name,
    depth: dir.depth,
  }
}

// The most specific framework whose config file or dependency is present.
function identify(files: Set<string>, deps: Set<string>) {
  const names = [...files]

  return frameworks
    .filter(
      (framework) =>
        framework.deps.some((dep) => deps.has(dep)) ||
        framework.configFiles.some((config) => names.some((name) => name.startsWith(`${config}.`))),
    )
    .sort((a, b) => b.specificity - a.specificity)[0]
}

type Choice = {
  command: string
  confidence: Preview.Candidate["confidence"]
  reason: string
  name: number
  cli?: Cli
}

function choose(
  scripts: Record<string, string>,
  framework: Framework | undefined,
  pm: PackageManager,
): Choice | undefined {
  const classified = Object.keys(scripts).map((name) => ({ name, script: classify(scripts, name) }))
  const order = (name: string) => (DEV_NAMES.includes(name) ? DEV_NAMES.indexOf(name) : DEV_NAMES.length)
  const byName = <T extends { name: string }>(items: T[]) => items.sort((a, b) => order(a.name) - order(b.name))

  const direct = byName(classified.filter((item) => item.script.kind === "dev")).sort(
    (a, b) => Number(own(b.script, framework)) - Number(own(a.script, framework)),
  )[0]

  if (direct?.script.kind === "dev")
    return {
      command: command(direct.script.bin, direct.script.args, direct.script.cli),
      confidence: "high",
      reason: `Runs the "${direct.name}" script with ${direct.script.cli.id}`,
      name: order(direct.name),
      cli: direct.script.cli,
    }

  const compound = byName(
    classified.filter((item) => item.script.kind === "compound" && DEV_NAMES.includes(item.name)),
  )[0]

  if (compound)
    return {
      command: `${pm} run ${compound.name}`,
      confidence: "medium",
      reason: `Runs the "${compound.name}" script, which starts more than one thing`,
      name: order(compound.name),
    }

  const tool = framework && cli(framework.cli)

  if (tool)
    return {
      command: command(tool.bins[0]!, tool.synth, tool),
      confidence: "high",
      reason: `Starts the ${framework.id} dev server`,
      name: DEV_NAMES.length,
      cli: tool,
    }

  const unknown = byName(
    classified.filter((item) => item.script.kind === "unknown" && DEV_NAMES.includes(item.name)),
  )[0]

  if (!unknown) return undefined

  return {
    command: `${pm} run ${unknown.name}`,
    confidence: "low",
    reason: `Runs the "${unknown.name}" script`,
    name: order(unknown.name),
  }
}

const own = (script: Script, framework: Framework | undefined) =>
  script.kind === "dev" && script.cli.id === framework?.cli

type Script =
  | { kind: "dev"; cli: Cli; bin: string; args: string[] }
  | { kind: "compound" }
  | { kind: "skip" }
  | { kind: "unknown" }

const RUNNERS: Record<string, ReadonlyArray<string>> = {
  npm: ["run", "run-script"],
  pnpm: ["run"],
  yarn: ["run"],
  bun: ["run"],
}

// What a script runs, following `npm run other` style indirection to the script it names.
function classify(scripts: Record<string, string>, name: string, seen = new Set<string>()): Script {
  const raw = scripts[name]

  if (raw === undefined || seen.has(name)) return { kind: "unknown" }
  seen.add(name)

  if (/&&|\|\||;|\||(^|[^&])&($|[^&])/.test(raw)) return { kind: "compound" }
  const tokens = strip(tokenize(raw))
  const bin = tokens[0]

  if (!bin) return { kind: "unknown" }

  if (["concurrently", "run-p", "run-s", "npm-run-all", "turbo", "nx", "lerna"].includes(bin))
    return { kind: "compound" }
  const target = indirect(tokens, scripts)

  if (target) return classify(scripts, target, seen)
  const tool = cliForBin(bin)

  if (!tool) return { kind: "unknown" }
  const args = tokens.slice(1)

  return tool.dev(args) ? { kind: "dev", cli: tool, bin, args } : { kind: "skip" }
}

// The script a package-manager call runs, when it runs another script of the same package.
function indirect(tokens: string[], scripts: Record<string, string>) {
  const [pm, verb, target] = tokens

  if (!pm || !(pm in RUNNERS)) return undefined

  if (verb && RUNNERS[pm]!.includes(verb) && target && target in scripts) return target

  if (verb && verb in scripts && (pm !== "npm" || verb === "start")) return verb

  return undefined
}

// Drops leading environment assignments and runners like `cross-env` and `npx`, which do not change the dev server.
function strip(tokens: string[]): string[] {
  const [first, ...rest] = tokens

  if (first === undefined) return tokens

  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(first) || first === "cross-env") return strip(rest)

  if (["npx", "bunx", "pnpx"].includes(first))
    return strip(rest.filter((token, index) => index > 0 || !token.startsWith("-")))

  return tokens
}

function tokenize(script: string) {
  return [...script.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((match) => match[1] ?? match[2] ?? match[3]!)
}

// The CLI's own arguments minus the port, host and open flags, which the preview owns, then the preview's flags.
function command(bin: string, args: ReadonlyArray<string>, tool: Cli) {
  const kept: string[] = []

  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!

    if (/^--(port|host|hostname|open)=/.test(arg) || BARE.has(arg)) continue

    if (!VALUED.has(arg)) {
      kept.push(arg)
      continue
    }
    // These take an optional value: skip it with the flag.
    const value = args[index + 1]

    if (value !== undefined && !value.startsWith("-")) index++
  }

  return [bin, ...kept, ...tool.flags].map(quote).join(" ")
}

const VALUED = new Set(["--port", "-p", "--host", "-H", "--hostname", "--open", "-o"])

const BARE = new Set(["--strictPort", "--no-open"])

const quote = (arg: string) => (/^[\w@%+=:,./{}-]+$/.test(arg) ? arg : JSON.stringify(arg))

function rank(items: Ranked[]) {
  // A documentation site only competes for first place when there is no app beside it.
  const app = items.some((item) => !item.docs)

  return items
    .map((item) =>
      app && item.docs && item.candidate.confidence === "high"
        ? { ...item, candidate: { ...item.candidate, confidence: "medium" as const } }
        : item,
    )
    .sort(
      (a, b) =>
        CONFIDENCE[a.candidate.confidence] - CONFIDENCE[b.candidate.confidence] ||
        Number(a.docs) - Number(b.docs) ||
        a.name - b.name ||
        a.depth - b.depth ||
        a.candidate.recipe.root.localeCompare(b.candidate.recipe.root),
    )
    .map((item) => item.candidate)
}

function parse(text: string | undefined): Record<string, unknown> | undefined {
  if (text === undefined) return undefined

  try {
    const value: unknown = JSON.parse(text)

    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

const join = (dir: string, name: string) => (dir === "." ? name : `${dir}/${name}`)

// The directory and each one above it, up to the project directory.
function ancestors(dir: string) {
  const parts = dir === "." ? [] : dir.split("/")

  return [...parts.map((_, index) => parts.slice(0, parts.length - index).join("/")), "."]
}
