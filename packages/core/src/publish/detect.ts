export * as PublishDetect from "./detect.js"

import type { Publish } from "@opencode/schema/publish"
import { directoryTree } from "../preview/controller.js"
import { detect, packageManager, type Tree } from "../preview/detect.js"

export type Result = { kind: Publish.Kind; framework: string; build?: string; output?: string } | { error: string }

// Used when package.json has no `build` script.
const BUILD: Record<string, string> = {
  vite: "npx vite build",
  cra: "npx react-scripts build",
  "vue-cli": "npx vue-cli-service build",
  parcel: "npx parcel build",
  webpack: "npx webpack build",
  angular: "npx ng build",
  gatsby: "npx gatsby build",
  docusaurus: "npx docusaurus build",
  eleventy: "npx @11ty/eleventy",
  astro: "npx astro build",
  sveltekit: "npx vite build",
  next: "npx next build",
  nuxt: "npx nuxt build",
  solidstart: "npx vinxi build",
  remix: "npx remix vite:build",
  "react-router": "npx react-router build",
}

/** How to publish the project at `root`: its kind, plus the build command and output directory when it has a build. */
export async function detectKind(root: string): Promise<Result> {
  const tree = directoryTree(root)
  const top = (await detect(tree)).find((candidate) => candidate.recipe.root === ".")
  const framework = top?.framework ?? "static"
  const names = await tree.list(".")

  if (framework === "static" || framework === "unknown") {
    if (names.some((entry) => !entry.dir && entry.name === "index.html"))
      return { kind: "static", framework: "static" }
    return {
      error: `O M A I + couldn't tell how to build this project. Found: ${
        names
          .map((entry) => entry.name)
          .slice(0, 20)
          .join(", ") || "nothing"
      }`,
    }
  }

  const build = await buildCommand(tree, framework)
  const done = (kind: Publish.Kind, output?: string) => ({ kind, framework, build, ...(output ? { output } : {}) })
  const config = (name: string) => readConfig(tree, names, name)

  switch (framework) {
    case "vite":
    case "vue-cli":
    case "parcel":
    case "webpack":
      return done("spa", "dist")
    case "cra":
      return done("spa", "build")
    case "angular":
      return done("spa", await angularOutput(tree))
    case "gatsby":
      return done("pages", "public")
    case "docusaurus":
      return done("pages", "build")
    case "eleventy":
      return done("pages", "_site")
    case "astro": {
      const source = await config("astro.config")
      return /output\s*:\s*["'](server|hybrid)["']|adapter\s*:/.test(source)
        ? done("astro-server")
        : done("pages", "dist")
    }
    case "sveltekit": {
      if (!(await hasDependency(tree, "@sveltejs/adapter-static"))) return done("sveltekit")
      // Kit 2 configures the adapter in svelte.config, Kit 3 in vite.config.
      const source = (await config("svelte.config")) + (await config("vite.config"))
      return done("pages", /pages\s*:\s*["']([^"']+)["']/.exec(source)?.[1] ?? "build")
    }
    case "next":
      return /output\s*:\s*["']export["']/.test(await config("next.config")) ? done("pages", "out") : done("next")
    case "nuxt":
      return done("nuxt")
    case "solidstart":
      return done("solidstart")
    case "remix":
    case "react-router":
      return /ssr\s*:\s*false/.test(await config("react-router.config"))
        ? done("spa", "build/client")
        : done("react-router")
  }

  return { error: `O M A I + doesn't know how to publish ${framework} projects yet.` }
}

async function buildCommand(tree: Tree, framework: string) {
  const scripts = (await packageJson(tree))?.scripts
  if (typeof scripts?.build === "string") return `${await packageManager(tree, ".")} run build`
  return BUILD[framework] ?? "npm run build"
}

// The first config file with this base name, whatever its extension. Empty when there is none.
async function readConfig(tree: Tree, names: Awaited<ReturnType<Tree["list"]>>, base: string) {
  const file = names.find((entry) => !entry.dir && entry.name.startsWith(`${base}.`))
  return file ? ((await tree.read(file.name)) ?? "") : ""
}

async function hasDependency(tree: Tree, name: string) {
  const json = await packageJson(tree)
  return !!(json?.dependencies?.[name] || json?.devDependencies?.[name])
}

type PackageJson = {
  scripts?: Record<string, unknown>
  dependencies?: Record<string, unknown>
  devDependencies?: Record<string, unknown>
}

async function packageJson(tree: Tree): Promise<PackageJson | undefined> {
  const text = await tree.read("package.json")
  return text === undefined ? undefined : parse<PackageJson>(text)
}

type AngularJson = {
  projects?: Record<
    string,
    { architect?: { build?: { builder?: string; options?: { outputPath?: string | { base?: string } } } } }
  >
}

// The application builders write the site to `<outputPath>/browser`; the older browser builder writes to outputPath.
async function angularOutput(tree: Tree) {
  const text = await tree.read("angular.json")
  const json: AngularJson = text ? (parse<AngularJson>(text) ?? {}) : {}
  const [name, project] = Object.entries(json.projects ?? {})[0] ?? ["app", undefined]
  const build = project?.architect?.build
  const configured = build?.options?.outputPath
  const base = (typeof configured === "string" ? configured : configured?.base) ?? `dist/${name}`
  const modern = /:application$|:browser-esbuild$/.test(build?.builder ?? "")
  const built = (await tree.list(base)).some((entry) => entry.dir && entry.name === "browser")
  return modern || built ? `${base}/browser` : base
}

function parse<T>(text: string): T | undefined {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}
