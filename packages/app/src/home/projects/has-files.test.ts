import { describe, expect, test } from "bun:test"
import { checkProjectFiles, hasProjectFiles } from "./has-files"

type Entry = { path: string; type: "file" | "directory" }

function context(list: () => Promise<{ data: Entry[] }>) {
  // SAFETY: hasProjectFiles only calls sdk.api.file.list.
  return { sdk: { api: { file: { list } } } } as unknown as Parameters<typeof hasProjectFiles>[0]
}

describe("hasProjectFiles", () => {
  test("true when a visible file or folder exists", async () => {
    const ctx = context(async () => ({
      data: [
        { path: ".git", type: "directory" },
        { path: "src", type: "directory" },
      ],
    }))
    expect(await hasProjectFiles(ctx, "/p")).toBe(true)
  })

  test("false when only hidden entries exist", async () => {
    const ctx = context(async () => ({
      data: [
        { path: ".git", type: "directory" },
        { path: ".gitignore", type: "file" },
      ],
    }))
    expect(await hasProjectFiles(ctx, "/p")).toBe(false)
  })

  test("false when listing fails", async () => {
    expect(
      await hasProjectFiles(
        context(() => Promise.reject(new Error("offline"))),
        "/p",
      ),
    ).toBe(false)
  })

  test("never waits past its limit", async () => {
    const started = Date.now()
    const slow = context(
      () => new Promise((resolve) => setTimeout(() => resolve({ data: [{ path: "a", type: "file" }] }), 2000)),
    )
    expect(await hasProjectFiles(slow, "/p", 50)).toBe(false)
    expect(Date.now() - started).toBeLessThan(500)
  })

  // A VM that just woke can't list yet: opening goes ahead with chat only, and the preview opens once files show up.
  test("a listing that fails at first still finds files for the later answer", async () => {
    const calls = { count: 0 }

    const ctx = context(async () => {
      calls.count += 1

      if (calls.count === 1) throw new Error("waking")

      return { data: [{ path: "index.html", type: "file" }] }
    })

    const check = checkProjectFiles(ctx, "/p", 10)

    expect(await check.now).toBe(false)
    expect(await check.later).toBe(true)
    expect(calls.count).toBe(2)
  })

  test("an empty project stays chat only", async () => {
    const check = checkProjectFiles(
      context(async () => ({ data: [{ path: ".git", type: "directory" }] })),
      "/p",
      10,
    )

    expect(await check.now).toBe(false)
    expect(await check.later).toBe(false)
  })
})
