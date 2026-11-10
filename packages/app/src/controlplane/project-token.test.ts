import { expect, test } from "bun:test"
import { projectReconnect, refreshProjectToken, setProjectTokenRefresh } from "./project-token"

const url = "https://router.test/vm/p1"

test("a rejected project token is replaced at most once a minute, and only while signed in", async () => {
  expect(await refreshProjectToken(url)).toBeUndefined()

  const calls: string[] = []

  const stop = setProjectTokenRefresh(async (wanted) => {
    calls.push(wanted)

    return { url: wanted, password: `token-${calls.length}` }
  })

  expect(await refreshProjectToken(url)).toEqual({ url, password: "token-1" })
  // Asked again straight away, e.g. by the health check after the stream: nothing new.
  expect(await refreshProjectToken(url)).toBeUndefined()
  expect(calls).toEqual([url])

  stop()
  expect(await refreshProjectToken("https://router.test/vm/p2")).toBeUndefined()
})

test("the stream's reconnect keeps the current endpoint when no fresh token comes back", async () => {
  const stop = setProjectTokenRefresh(async () => undefined)
  const current = { url, password: "old" }

  expect(await projectReconnect(() => current)(new AbortController().signal)).toBe(current)
  stop()
})
