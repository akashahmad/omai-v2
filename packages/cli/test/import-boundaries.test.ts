import { describe, expect, test } from "bun:test"
import path from "node:path"

const root = path.resolve(import.meta.dir, "../../..")

describe("CLI frontend import boundaries", () => {
  test("does not import Core directly", async () => {
    const glob = new Bun.Glob("{src,test}/**/*.{ts,tsx}")
    const imports: string[] = []
    for await (const file of glob.scan({ cwd: path.join(root, "packages/cli") })) {
      const source = await Bun.file(path.join(root, "packages/cli", file)).text()
      if (/["']@opencode\/core(?:\/[^"']*)?["']/.test(source)) imports.push(file)
    }
    expect(imports).toEqual([])
  })
})
