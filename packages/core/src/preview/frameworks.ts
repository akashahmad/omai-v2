// The dev servers the preview knows how to start, and the frameworks that use them.

/** A dev-server command line tool: how to tell its dev invocation from a build, and the flags that pin port and host. */
export interface Cli {
  readonly id: string
  /** The binary names it runs as. */
  readonly bins: ReadonlyArray<string>
  /** Whether the arguments after the binary start the dev server rather than a build or a production server. */
  readonly dev: (args: ReadonlyArray<string>) => boolean
  /** The arguments a synthesised command passes after the binary. */
  readonly synth: ReadonlyArray<string>
  /** Appended to every direct call; `{port}` is the assigned port. */
  readonly flags: ReadonlyArray<string>
}

export interface Framework {
  readonly id: string
  readonly cli: string
  /** Config file names without their extension. */
  readonly configFiles: ReadonlyArray<string>
  readonly deps: ReadonlyArray<string>
  /** The more specific framework wins when several match, like Nuxt over Vite. */
  readonly specificity: number
  /** A documentation site ranks below an app in the same project. */
  readonly docs?: boolean
}

const HOST = "127.0.0.1"

const subcommand =
  (...names: string[]) =>
  (args: ReadonlyArray<string>) =>
    names.includes(args[0] ?? "")

// Vite runs the dev server bare, with only flags, or as `vite dev` / `vite serve`.
const bareOr =
  (...names: string[]) =>
  (args: ReadonlyArray<string>) =>
    args.length === 0 || args[0]!.startsWith("-") || names.includes(args[0]!)

export const clis: ReadonlyArray<Cli> = [
  {
    id: "vite",
    bins: ["vite"],
    dev: bareOr("dev", "serve"),
    synth: [],
    flags: ["--port", "{port}", "--host", HOST, "--strictPort"],
  },
  { id: "next", bins: ["next"], dev: subcommand("dev"), synth: ["dev"], flags: ["-p", "{port}", "-H", HOST] },
  {
    id: "nuxt",
    bins: ["nuxt", "nuxi"],
    dev: subcommand("dev"),
    synth: ["dev"],
    flags: ["--port", "{port}", "--host", HOST],
  },
  { id: "astro", bins: ["astro"], dev: subcommand("dev"), synth: ["dev"], flags: ["--port", "{port}", "--host", HOST] },
  {
    id: "angular",
    bins: ["ng"],
    dev: subcommand("serve"),
    synth: ["serve"],
    flags: ["--port", "{port}", "--host", HOST],
  },
  { id: "vinxi", bins: ["vinxi"], dev: subcommand("dev"), synth: ["dev"], flags: ["--port", "{port}", "--host", HOST] },
  {
    id: "remix",
    bins: ["remix"],
    dev: subcommand("vite:dev"),
    synth: ["vite:dev"],
    flags: ["--port", "{port}", "--host", HOST],
  },
  {
    id: "react-router",
    bins: ["react-router"],
    dev: subcommand("dev"),
    synth: ["dev"],
    flags: ["--port", "{port}", "--host", HOST],
  },
  {
    id: "gatsby",
    bins: ["gatsby"],
    dev: subcommand("develop"),
    synth: ["develop"],
    flags: ["-p", "{port}", "-H", HOST],
  },
  {
    id: "docusaurus",
    bins: ["docusaurus"],
    dev: subcommand("start"),
    synth: ["start"],
    flags: ["--port", "{port}", "--host", HOST, "--no-open"],
  },
  {
    id: "eleventy",
    bins: ["eleventy"],
    dev: (args) => args.includes("--serve"),
    synth: ["--serve"],
    flags: ["--port", "{port}"],
  },
  {
    id: "vue-cli",
    bins: ["vue-cli-service"],
    dev: subcommand("serve"),
    synth: ["serve"],
    flags: ["--port", "{port}", "--host", HOST],
  },
  // Create React App reads PORT and HOST from the environment and has no flags for them.
  { id: "cra", bins: ["react-scripts"], dev: subcommand("start"), synth: ["start"], flags: [] },
  {
    id: "parcel",
    bins: ["parcel"],
    dev: (args) => !["build", "watch"].includes(args[0] ?? ""),
    synth: ["index.html"],
    flags: ["--port", "{port}"],
  },
  {
    id: "webpack",
    bins: ["webpack", "webpack-dev-server"],
    dev: (args) => args[0] === "serve" || args.length === 0 || args[0]!.startsWith("-"),
    synth: ["serve"],
    flags: ["--port", "{port}", "--host", HOST],
  },
]

export const frameworks: ReadonlyArray<Framework> = [
  { id: "next", cli: "next", configFiles: ["next.config"], deps: ["next"], specificity: 3 },
  { id: "nuxt", cli: "nuxt", configFiles: ["nuxt.config"], deps: ["nuxt"], specificity: 3 },
  { id: "astro", cli: "astro", configFiles: ["astro.config"], deps: ["astro"], specificity: 3 },
  { id: "angular", cli: "angular", configFiles: ["angular"], deps: ["@angular/cli"], specificity: 3 },
  { id: "sveltekit", cli: "vite", configFiles: [], deps: ["@sveltejs/kit"], specificity: 3 },
  { id: "remix", cli: "remix", configFiles: [], deps: ["@remix-run/dev"], specificity: 3 },
  {
    id: "react-router",
    cli: "react-router",
    configFiles: ["react-router.config"],
    deps: ["@react-router/dev"],
    specificity: 3,
  },
  { id: "solidstart", cli: "vinxi", configFiles: [], deps: ["@solidjs/start"], specificity: 3 },
  { id: "gatsby", cli: "gatsby", configFiles: ["gatsby-config"], deps: ["gatsby"], specificity: 3 },
  {
    id: "docusaurus",
    cli: "docusaurus",
    configFiles: ["docusaurus.config"],
    deps: ["@docusaurus/core"],
    specificity: 3,
    docs: true,
  },
  {
    id: "eleventy",
    cli: "eleventy",
    configFiles: [".eleventy", "eleventy.config"],
    deps: ["@11ty/eleventy"],
    specificity: 3,
  },
  { id: "vue-cli", cli: "vue-cli", configFiles: ["vue.config"], deps: ["@vue/cli-service"], specificity: 2 },
  { id: "cra", cli: "cra", configFiles: [], deps: ["react-scripts"], specificity: 2 },
  { id: "vite", cli: "vite", configFiles: ["vite.config"], deps: ["vite"], specificity: 1 },
  { id: "parcel", cli: "parcel", configFiles: [], deps: ["parcel"], specificity: 1 },
  { id: "webpack", cli: "webpack", configFiles: [], deps: ["webpack-dev-server"], specificity: 1 },
]

export const cli = (id: string) => clis.find((item) => item.id === id)

export const cliForBin = (bin: string) => clis.find((item) => item.bins.includes(bin))
