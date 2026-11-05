import { describe, expect, test } from "bun:test"
import { detect, packageManager, type Tree } from "@opencode/core/preview/detect"

// An in-memory project: paths to file contents. Directories are implied by the paths under them.
function tree(files: Record<string, string>): Tree {
  return {
    read: async (file) => files[file],
    list: async (dir) => {
      const prefix = dir === "." ? "" : `${dir}/`
      const names = new Map<string, boolean>()
      Object.keys(files)
        .filter((file) => file.startsWith(prefix))
        .forEach((file) => {
          const rest = file.slice(prefix.length)
          const slash = rest.indexOf("/")
          names.set(slash === -1 ? rest : rest.slice(0, slash), slash !== -1)
        })
      return [...names].map(([name, isDir]) => ({ name, dir: isDir }))
    },
  }
}

const pkg = (value: Record<string, unknown>) => JSON.stringify(value)

describe("detect", () => {
  test("vite react", async () => {
    const [first] = await detect(
      tree({
        "package.json": pkg({ scripts: { dev: "vite" }, devDependencies: { vite: "6", react: "19" } }),
        "vite.config.ts": "",
      }),
    )

    expect(first?.framework).toBe("vite")
    expect(first?.confidence).toBe("high")
    expect(first?.recipe.command).toBe("vite --port {port} --host 127.0.0.1 --strictPort")
    expect(first?.recipe.root).toBe(".")
  })

  test("nuxt wins over vite", async () => {
    const [first] = await detect(
      tree({
        "package.json": pkg({ scripts: { dev: "nuxt dev" }, dependencies: { nuxt: "3", vite: "6" } }),
        "nuxt.config.ts": "",
      }),
    )

    expect(first?.framework).toBe("nuxt")
    expect(first?.recipe.command).toBe("nuxt dev --port {port} --host 127.0.0.1")
  })

  test("next keeps its own args and takes our port", async () => {
    const [first] = await detect(
      tree({ "package.json": pkg({ scripts: { dev: "next dev --turbo -p 3001" }, dependencies: { next: "15" } }) }),
    )

    expect(first?.recipe.command).toBe("next dev --turbo -p {port} -H 127.0.0.1")
  })

  test("create react app takes its port from env", async () => {
    const [first] = await detect(
      tree({
        "package.json": pkg({ scripts: { start: "react-scripts start" }, dependencies: { "react-scripts": "5" } }),
      }),
    )

    expect(first?.framework).toBe("cra")
    expect(first?.recipe.command).toBe("react-scripts start")
  })

  test("angular", async () => {
    const [first] = await detect(
      tree({
        "package.json": pkg({ scripts: { start: "ng serve" }, devDependencies: { "@angular/cli": "19" } }),
        "angular.json": "{}",
      }),
    )

    expect(first?.framework).toBe("angular")
    expect(first?.recipe.command).toBe("ng serve --port {port} --host 127.0.0.1")
  })

  test("react router framework mode", async () => {
    const [first] = await detect(
      tree({
        "package.json": pkg({ scripts: { dev: "react-router dev" }, devDependencies: { "@react-router/dev": "7" } }),
      }),
    )

    expect(first?.framework).toBe("react-router")
    expect(first?.recipe.command).toBe("react-router dev --port {port} --host 127.0.0.1")
  })

  test("a compound script runs as is", async () => {
    const [first] = await detect(
      tree({
        "package.json": pkg({ scripts: { dev: 'concurrently "vite" "node api.js"' }, devDependencies: { vite: "6" } }),
      }),
    )

    expect(first?.recipe.command).toBe("npm run dev")
    expect(first?.confidence).toBe("medium")
  })

  test("follows npm run to the real command", async () => {
    const [first] = await detect(
      tree({
        "package.json": pkg({ scripts: { dev: "npm run start", start: "vite" }, devDependencies: { vite: "6" } }),
      }),
    )

    expect(first?.recipe.command).toBe("vite --port {port} --host 127.0.0.1 --strictPort")
  })

  test("never picks a build or a production server", async () => {
    const [first] = await detect(
      tree({
        "package.json": pkg({ scripts: { build: "next build", start: "next start" }, dependencies: { next: "15" } }),
      }),
    )

    expect(first?.recipe.command).toBe("next dev -p {port} -H 127.0.0.1")
  })

  test("synthesises the dev command without scripts", async () => {
    const [first] = await detect(tree({ "package.json": pkg({ devDependencies: { vite: "6" } }), "index.html": "" }))

    expect(first?.framework).toBe("vite")
    expect(first?.recipe.command).toBe("vite --port {port} --host 127.0.0.1 --strictPort")
  })

  test("unwraps a zip folder", async () => {
    const [first] = await detect(
      tree({
        "__MACOSX/my-site/._package.json": "",
        "my-site/package.json": pkg({ scripts: { dev: "vite" }, devDependencies: { vite: "6" } }),
      }),
    )

    expect(first?.recipe.root).toBe("my-site")
  })

  test("stops searching below depth three", async () => {
    expect(await detect(tree({ "a/b/c/d/package.json": pkg({ scripts: { dev: "vite" } }) }))).toEqual([])
  })

  test("lists every app of a monorepo, the best first", async () => {
    const candidates = await detect(
      tree({
        "package.json": pkg({ private: true, workspaces: ["apps/*"] }),
        "apps/web/package.json": pkg({ scripts: { dev: "next dev" }, dependencies: { next: "15" } }),
        "apps/docs/package.json": pkg({
          scripts: { start: "docusaurus start" },
          dependencies: { "@docusaurus/core": "3" },
        }),
      }),
    )

    expect(candidates.map((candidate) => candidate.recipe.root)).toEqual(["apps/web", "apps/docs"])
  })

  test("a plain html site is static", async () => {
    const [first] = await detect(tree({ "index.html": "<h1>hi</h1>", "style.css": "" }))

    expect(first?.recipe.kind).toBe("static")
    expect(first?.recipe.root).toBe(".")
    expect(first?.recipe.install).toBeUndefined()
  })

  test("static in public", async () => {
    const [first] = await detect(tree({ "public/index.html": "" }))

    expect(first?.recipe).toMatchObject({ kind: "static", root: "public" })
  })

  test("nothing to preview", async () => {
    expect(await detect(tree({ "README.md": "# hi" }))).toEqual([])
  })
})

describe("packageManager", () => {
  test("from the lockfile", async () => {
    expect(await packageManager(tree({ "package.json": "{}", "pnpm-lock.yaml": "" }), ".")).toBe("pnpm")
  })

  test("packageManager field beats the lockfile", async () => {
    expect(
      await packageManager(
        tree({ "package.json": pkg({ packageManager: "yarn@4.1.0" }), "package-lock.json": "" }),
        ".",
      ),
    ).toBe("yarn")
  })
})
