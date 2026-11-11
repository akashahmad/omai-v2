import { expect, test } from "bun:test"
import { projectReconnect, refreshProjectToken, setProjectTokenRefresh } from "./project-token"

const url = "https://router.test/vm/p1"

test("a rejected project token is replaced at most once a minute, and only while signed in", async () => {
  expect(await refreshProjectToken(url)).toBeUndefined()

  const calls: string[] = []

  const stop = setProjectTokenRefresh(
    async (wanted) => {
      calls.push(wanted)

      return { url: wanted, password: `token-${calls.length}` }
    },
    () => true,
  )

  expect(await refreshProjectToken(url)).toEqual({ url, password: "token-1" })
  // Asked again straight away, e.g. by the health check after the stream: nothing new.
  expect(await refreshProjectToken(url)).toBeUndefined()
  expect(calls).toEqual([url])

  stop()
  expect(await refreshProjectToken("https://router.test/vm/p2")).toBeUndefined()
})

test("the stream's reconnect keeps the current endpoint when no fresh token comes back", async () => {
  const stop = setProjectTokenRefresh(
    async () => undefined,
    () => true,
  )
  const current = { url, password: "old" }

  expect(await projectReconnect(() => current)(new AbortController().signal)).toBe(current)
  stop()
})

// A fresh token opens the project, which starts its VM: the app keeps a connection to every project it opened, and
// after a new sign-in all of them are turned away at once. Only the project on screen may be opened for that.
test("only a project the user is on gets a fresh token, and one skipped can still get it once the user is there", async () => {
  const calls: string[] = []
  const on = { url: "" }
  const stop = setProjectTokenRefresh(
    async (wanted) => {
      calls.push(wanted)

      return { url: wanted, password: "fresh" }
    },
    (wanted) => wanted === on.url,
  )
  const other = "https://router.test/vm/p3"

  expect(await refreshProjectToken(other)).toBeUndefined()
  expect(calls).toEqual([])
  on.url = other
  expect(await refreshProjectToken(other)).toEqual({ url: other, password: "fresh" })
  expect(calls).toEqual([other])
  stop()
})
