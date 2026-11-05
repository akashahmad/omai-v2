// Starts real projects of every framework the preview supports and checks each comes up through the proxy.
// Needs network for the scaffolders and installs, so it is a manual check, not a unit test:
//   cd packages/core && bunx bun@1.4.4 script/preview-matrix.ts [name ...]

import { spawnSync } from "node:child_process"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { request } from "node:http"
import { connect } from "node:net"
import { tmpdir } from "node:os"
import path from "node:path"
import { createController } from "../src/preview/controller.js"

type Entry = { name: string; scaffold: (parent: string) => Promise<string>; hmr?: "vite"; hmrPath?: string }

const sh = (cwd: string, command: string) => {
  const result = spawnSync("sh", ["-c", command], {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, CI: "1", npm_config_yes: "true" },
    timeout: 600_000,
    encoding: "utf8",
  })

  if (result.status !== 0) throw new Error(`${command} failed:\n${(result.stderr || result.stdout).slice(-2000)}`)
}

const files = async (dir: string, entries: Record<string, string>) => {
  for (const [file, body] of Object.entries(entries)) {
    await mkdir(path.dirname(path.join(dir, file)), { recursive: true })
    await writeFile(path.join(dir, file), body)
  }

  return dir
}

const vite = (template: string): Entry => ({
  name: `vite-${template}`,
  hmr: "vite",
  scaffold: async (parent) => {
    sh(parent, `npm create -y vite@latest app -- --template ${template} --no-interactive`)
    return path.join(parent, "app")
  },
})

const entries: Entry[] = [
  ...["vanilla", "react-ts", "vue-ts", "svelte-ts", "solid-ts", "preact-ts", "lit-ts"].map(vite),
  {
    name: "next",
    scaffold: async (parent) => {
      sh(parent, "npx -y create-next-app@latest app --yes --skip-install --disable-git")
      return path.join(parent, "app")
    },
  },
  {
    name: "nuxt",
    hmr: "vite",
    // Nuxt serves Vite's hot reload under its build path.
    hmrPath: "/_nuxt/",
    scaffold: async (parent) => {
      sh(parent, "npx -y nuxi@latest init app --packageManager npm --gitInit false --no-install --template minimal")
      return path.join(parent, "app")
    },
  },
  {
    name: "astro",
    hmr: "vite",
    scaffold: async (parent) => {
      sh(parent, "npm create -y astro@latest app -- --template minimal --no-install --no-git --skip-houston --yes")
      return path.join(parent, "app")
    },
  },
  {
    name: "angular",
    scaffold: async (parent) => {
      sh(parent, "npx -y @angular/cli@latest new app --defaults --skip-git --skip-install --ssr=false")
      return path.join(parent, "app")
    },
  },
  {
    name: "sveltekit",
    hmr: "vite",
    scaffold: async (parent) => {
      sh(parent, "npx -y sv@latest create app --template minimal --types ts --no-add-ons --no-install")
      return path.join(parent, "app")
    },
  },
  {
    name: "react-router",
    hmr: "vite",
    scaffold: async (parent) => {
      sh(parent, "npx -y create-react-router@latest app --yes --no-install --no-git-init")
      return path.join(parent, "app")
    },
  },
  {
    name: "docusaurus",
    scaffold: async (parent) => {
      sh(parent, "npx -y create-docusaurus@latest app classic --skip-install --javascript")
      return path.join(parent, "app")
    },
  },
  {
    name: "cra",
    scaffold: async (parent) => {
      sh(parent, "npx -y create-react-app app")
      return path.join(parent, "app")
    },
  },
  {
    name: "eleventy",
    scaffold: (parent) =>
      files(path.join(parent, "app"), {
        "package.json": JSON.stringify({ name: "site", devDependencies: { "@11ty/eleventy": "^3.0.0" } }),
        "index.md": "# Hello from Eleventy\n",
      }),
  },
  {
    name: "parcel",
    scaffold: (parent) =>
      files(path.join(parent, "app"), {
        "package.json": JSON.stringify({ name: "site", devDependencies: { parcel: "^2.13.0" } }),
        "index.html":
          '<!doctype html><html><head><title>p</title></head><body><script type="module" src="./main.js"></script></body></html>',
        "main.js": 'document.body.append("parcel works")\n',
      }),
  },
  {
    name: "static",
    scaffold: (parent) =>
      files(path.join(parent, "app"), {
        "index.html":
          '<!doctype html><html><head><link rel="stylesheet" href="style.css"></head><body><script src="app.js"></script></body></html>',
        "style.css": "body { color: rebeccapurple }",
        "app.js": "console.log('static')",
      }),
  },
  {
    name: "zip-wrapped-vite",
    hmr: "vite",
    scaffold: async (parent) => {
      const wrapper = path.join(parent, "upload")
      await mkdir(path.join(wrapper, "__MACOSX"), { recursive: true })
      sh(wrapper, "npm create -y vite@latest my-site -- --template react-ts --no-interactive")
      return wrapper
    },
  },
]

function get(port: number, url: string, accept = "text/html") {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path: url, headers: { accept } }, (res) => {
      const chunks: Buffer[] = []
      res.on("data", (chunk: Buffer) => chunks.push(chunk))
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }))
    })
    req.on("error", reject)
    req.setTimeout(60_000, () => req.destroy(new Error("timeout")))
    req.end()
  })
}

function viteHmr(port: number, hmrPath = "/") {
  return new Promise<boolean>((resolve) => {
    const socket = connect(port, "127.0.0.1", () =>
      socket.write(
        [
          `GET ${hmrPath} HTTP/1.1`,
          `Host: 127.0.0.1:${port}`,
          "Upgrade: websocket",
          "Connection: Upgrade",
          "Sec-WebSocket-Version: 13",
          "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
          "Sec-WebSocket-Protocol: vite-hmr",
          "",
          "",
        ].join("\r\n"),
      ),
    )
    socket.once("data", (data) => {
      resolve(data.toString().startsWith("HTTP/1.1 101"))
      socket.destroy()
    })
    socket.once("error", () => resolve(false))
    setTimeout(() => {
      resolve(false)
      socket.destroy()
    }, 10_000)
  })
}

async function check(entry: Entry) {
  const parent = await mkdtemp(path.join(tmpdir(), `omai-matrix-${entry.name}-`))
  const directory = await entry.scaffold(parent)
  const store = new Map<string, unknown>()
  const log: string[] = []
  const controller = createController({
    directory,
    hostname: "127.0.0.1",
    store: { get: async (key) => store.get(key), set: async (key, value) => void store.set(key, value) },
    config: () => undefined,
    emit: { changed: () => {}, log: (chunk) => log.push(chunk) },
  })

  try {
    const status = await controller.start()

    if (status.state !== "running") return `state ${status.state}: ${status.reason ?? ""}\n${log.join("").slice(-1500)}`
    const page = await get(status.port!, "/")

    if (!page.body.includes("/__omai/bridge.js")) return `no bridge in / (status ${page.status})`
    const script = [...page.body.matchAll(/<script[^>]*\bsrc="([^"]+)"/g)]
      .map((match) => match[1]!)
      .find((src) => !src.startsWith("/__omai/") && !src.startsWith("http"))

    if (script) {
      const asset = await get(status.port!, new URL(script, "http://x/").pathname, "*/*")

      if (asset.status !== 200) return `script ${script} answered ${asset.status}`
    }

    // Some dev servers (Nuxt) answer with a loading page while they build; hot reload comes up after.
    const hmr = async () => {
      for (let tries = 0; tries < 30; tries++) {
        if (await viteHmr(status.port!, entry.hmrPath)) return true
        await Bun.sleep(2_000)
      }
      return false
    }

    if (entry.hmr === "vite" && !(await hmr())) return "the vite HMR websocket did not upgrade"

    return `PASS (${status.recipe?.command ?? status.recipe?.kind}, ${status.framework ?? ""})`
  } finally {
    await controller.close()
  }
}

const only = process.argv.slice(2)

for (const entry of entries.filter((item) => only.length === 0 || only.includes(item.name))) {
  const started = Date.now()
  const result = await check(entry).catch(
    (cause: unknown) => `error: ${cause instanceof Error ? cause.message : cause}`,
  )
  console.log(
    `${result.startsWith("PASS") ? "PASS" : "FAIL"} ${entry.name} [${Math.round((Date.now() - started) / 1000)}s] ${result}`,
  )
}

process.exit(0)
