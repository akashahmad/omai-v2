import { expect, test } from "bun:test"
import { ClientError } from "@opencode/client/promise"
import { fetchChunks } from "./download"

const encode = (text: string) => Buffer.from(text).toString("base64")

test("a piece lost to a dropped connection is read again, and the file comes out whole", async () => {
  const calls: number[] = []

  const blob = await fetchChunks(
    async (offset) => {
      calls.push(offset)

      // The second piece's first request never gets an answer.
      if (offset === 3 && calls.filter((value) => value === 3).length === 1)
        throw new ClientError("Transport", { cause: new TypeError("Failed to fetch") })

      return { data: encode(offset === 0 ? "abc" : "def"), size: 6 }
    },
    "project.zip",
    () => undefined,
    new AbortController().signal,
  )

  expect(await blob.text()).toBe("abcdef")
  expect(calls).toEqual([0, 3, 3])
})

test("an error the server answered with fails the download at once", async () => {
  const calls: number[] = []

  const download = fetchChunks(
    async (offset) => {
      calls.push(offset)
      throw new Error("This download expired. Start it again.")
    },
    "project.zip",
    () => undefined,
    new AbortController().signal,
  )

  await expect(download).rejects.toThrow("This download expired")
  expect(calls).toEqual([0])
})
