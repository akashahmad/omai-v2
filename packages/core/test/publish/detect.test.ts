import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { PublishDetect } from "../../src/publish/detect"

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function project(files: Record<string, string | object>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "omai-publish-detect-"))
  dirs.push(root)
  await Promise.all(
    Object.entries(files).map(async ([name, content]) => {
      await mkdir(path.dirname(path.join(root, name)), { recursive: true })
      await writeFile(path.join(root, name), typeof content === "string" ? content : JSON.stringify(content))
    }),
  )
  return root
}

const pkg = (dep: string, extra: object = {}) => ({
  scripts: { dev: "echo dev", build: "echo build" },
  dependencies: { [dep]: "1.0.0" },
  ...extra,
})

describe("publish detect", () => {
  test("detects a root index.html as static", async () => {
    const root = await project({ "index.html": "<h1>hi</h1>" })
    expect(await PublishDetect.detectKind(root)).toEqual({ kind: "static", framework: "static" })
  })

  test("ignores public/index.html and dist/index.html alone", async () => {
    const root = await project({ "public/index.html": "x", "dist/index.html": "x" })
    const result = await PublishDetect.detectKind(root)
    expect(result).toHaveProperty("error")
    expect((result as { error: string }).error).toContain("O M A I +")
  })

  test("detects vite as spa", async () => {
    const root = await project({ "package.json": pkg("vite"), "package-lock.json": "{}" })
    expect(await PublishDetect.detectKind(root)).toEqual({
      kind: "spa",
      framework: "vite",
      build: "npm run build",
      output: "dist",
    })
  })

  test("uses the detected package manager for the build script", async () => {
    const root = await project({ "package.json": pkg("vite"), "pnpm-lock.yaml": "" })
    expect(await PublishDetect.detectKind(root)).toMatchObject({ build: "pnpm run build" })
  })

  test("falls back to the framework build command without a build script", async () => {
    const root = await project({ "package.json": { scripts: { dev: "vite" }, devDependencies: { vite: "1" } } })
    expect(await PublishDetect.detectKind(root)).toMatchObject({ kind: "spa", build: "npx vite build" })
  })

  test("detects cra as spa with build output", async () => {
    const root = await project({ "package.json": pkg("react-scripts") })
    expect(await PublishDetect.detectKind(root)).toMatchObject({ kind: "spa", framework: "cra", output: "build" })
  })

  test("detects vue-cli, parcel and webpack as spa", async () => {
    const vue = await project({ "package.json": pkg("@vue/cli-service") })
    const parcel = await project({ "package.json": pkg("parcel") })
    const webpack = await project({ "package.json": pkg("webpack-dev-server") })
    expect(await PublishDetect.detectKind(vue)).toMatchObject({ kind: "spa", output: "dist" })
    expect(await PublishDetect.detectKind(parcel)).toMatchObject({ kind: "spa", output: "dist" })
    expect(await PublishDetect.detectKind(webpack)).toMatchObject({ kind: "spa", output: "dist" })
  })

  test("detects angular as spa and reads outputPath", async () => {
    const root = await project({
      "package.json": pkg("@angular/cli"),
      "angular.json": {
        projects: { app: { architect: { build: { builder: "@angular/build:application", options: { outputPath: "dist/app" } } } } },
      },
    })
    expect(await PublishDetect.detectKind(root)).toMatchObject({
      kind: "spa",
      framework: "angular",
      output: "dist/app/browser",
    })
  })

  test("detects angular with a legacy builder without browser", async () => {
    const root = await project({
      "package.json": pkg("@angular/cli"),
      "angular.json": {
        projects: {
          app: { architect: { build: { builder: "@angular-devkit/build-angular:browser", options: { outputPath: "dist/app" } } } },
        },
      },
    })
    expect(await PublishDetect.detectKind(root)).toMatchObject({ output: "dist/app" })
  })

  test("detects gatsby, docusaurus and eleventy as pages", async () => {
    const gatsby = await project({ "package.json": pkg("gatsby") })
    const docusaurus = await project({ "package.json": pkg("@docusaurus/core") })
    const eleventy = await project({ "package.json": pkg("@11ty/eleventy") })
    expect(await PublishDetect.detectKind(gatsby)).toMatchObject({ kind: "pages", output: "public" })
    expect(await PublishDetect.detectKind(docusaurus)).toMatchObject({ kind: "pages", output: "build" })
    expect(await PublishDetect.detectKind(eleventy)).toMatchObject({ kind: "pages", output: "_site" })
  })

  test("detects static astro as pages", async () => {
    const root = await project({ "package.json": pkg("astro"), "astro.config.mjs": "export default {}" })
    expect(await PublishDetect.detectKind(root)).toMatchObject({ kind: "pages", framework: "astro", output: "dist" })
  })

  test("detects astro with server output or an adapter as astro-server", async () => {
    const server = await project({ "package.json": pkg("astro"), "astro.config.mjs": 'export default { output: "server" }' })
    const hybrid = await project({ "package.json": pkg("astro"), "astro.config.ts": "export default { output: 'hybrid' }" })
    const adapter = await project({ "package.json": pkg("astro"), "astro.config.mjs": "export default { adapter: node() }" })
    expect(await PublishDetect.detectKind(server)).toMatchObject({ kind: "astro-server" })
    expect(await PublishDetect.detectKind(hybrid)).toMatchObject({ kind: "astro-server" })
    expect(await PublishDetect.detectKind(adapter)).toMatchObject({ kind: "astro-server" })
  })

  test("detects sveltekit with adapter-static as pages", async () => {
    const plain = await project({
      "package.json": pkg("@sveltejs/kit", { devDependencies: { "@sveltejs/adapter-static": "1" } }),
    })
    const custom = await project({
      "package.json": pkg("@sveltejs/kit", { devDependencies: { "@sveltejs/adapter-static": "1" } }),
      "svelte.config.js": 'export default { kit: { adapter: adapter({ pages: "site" }) } }',
    })
    expect(await PublishDetect.detectKind(plain)).toMatchObject({ kind: "pages", output: "build" })
    expect(await PublishDetect.detectKind(custom)).toMatchObject({ kind: "pages", output: "site" })
    const kit3 = await project({
      "package.json": pkg("@sveltejs/kit", { devDependencies: { "@sveltejs/adapter-static": "4" } }),
      "vite.config.js": 'export default { plugins: [sveltekit({ adapter: adapter({ pages: "public-site" }) })] }',
    })
    expect(await PublishDetect.detectKind(kit3)).toMatchObject({ kind: "pages", output: "public-site" })
  })

  test("detects sveltekit without adapter-static as sveltekit", async () => {
    const root = await project({ "package.json": pkg("@sveltejs/kit") })
    expect(await PublishDetect.detectKind(root)).toMatchObject({ kind: "sveltekit", framework: "sveltekit" })
  })

  test("detects next export as pages", async () => {
    const root = await project({ "package.json": pkg("next"), "next.config.mjs": 'export default { output: "export" }' })
    expect(await PublishDetect.detectKind(root)).toMatchObject({ kind: "pages", framework: "next", output: "out" })
  })

  test("detects next without export as next", async () => {
    const root = await project({ "package.json": pkg("next"), "next.config.js": "module.exports = {}" })
    expect(await PublishDetect.detectKind(root)).toMatchObject({ kind: "next" })
  })

  test("detects nuxt and solidstart", async () => {
    const nuxt = await project({ "package.json": pkg("nuxt") })
    const solid = await project({ "package.json": pkg("@solidjs/start") })
    expect(await PublishDetect.detectKind(nuxt)).toMatchObject({ kind: "nuxt" })
    expect(await PublishDetect.detectKind(solid)).toMatchObject({ kind: "solidstart" })
  })

  test("detects react-router with ssr false as spa", async () => {
    const root = await project({
      "package.json": pkg("@react-router/dev"),
      "react-router.config.ts": "export default { ssr: false }",
    })
    expect(await PublishDetect.detectKind(root)).toMatchObject({ kind: "spa", output: "build/client" })
  })

  test("detects react-router and remix otherwise as react-router", async () => {
    const rr = await project({ "package.json": pkg("@react-router/dev"), "react-router.config.ts": "export default {}" })
    const remix = await project({ "package.json": pkg("@remix-run/dev") })
    expect(await PublishDetect.detectKind(rr)).toMatchObject({ kind: "react-router" })
    expect(await PublishDetect.detectKind(remix)).toMatchObject({ kind: "react-router" })
  })

  test("reports what it found when nothing matches", async () => {
    const root = await project({ "README.md": "hello", "src/main.py": "" })
    const result = await PublishDetect.detectKind(root)
    expect(result).toEqual({ error: expect.stringContaining("O M A I + couldn't tell how to build this project. Found:") })
  })
})
