#!/usr/bin/env bun
// Bundles the control plane and its admin scripts for Node into dist/node: the deployed control plane runs on Node,
// not Bun. PGlite (it loads its WebAssembly from its own folder) and pg stay outside the bundle and are installed next
// to it. The output sits two folders deep, like src/, so the code finds `../../migration` the same way.
const built = await Bun.build({
  entrypoints: ["src/main.ts", "script/user-create.ts", "script/user-admin.ts"].map((file) =>
    new URL(`../${file}`, import.meta.url).pathname,
  ),
  target: "node",
  outdir: new URL("../dist/node", import.meta.url).pathname,
  naming: "[name].[ext]",
  external: ["@electric-sql/pglite", "pg"],
})
if (!built.success) {
  console.error(built.logs.join("\n"))
  process.exit(1)
}
// What a Node image installs next to the bundle: the packages left out of it, at the versions this package declares.
// "module", or Node would read the bundle as CommonJS.
const own = await Bun.file(new URL("../package.json", import.meta.url)).json()
await Bun.write(
  new URL("../dist/node/package.json", import.meta.url),
  JSON.stringify(
    {
      private: true,
      type: "module",
      dependencies: { "@electric-sql/pglite": own.dependencies["@electric-sql/pglite"], pg: own.dependencies.pg },
    },
    null,
    2,
  ) + "\n",
)
console.log(built.outputs.map((output) => output.path).join("\n"))
