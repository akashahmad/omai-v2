import { expect, test } from "bun:test"
import type { SessionMessageAssistant, SessionMessageInfo, SessionMessageUser } from "@opencode/client/promise"
import { selectSessionUserMessages, selectVisibleSessionUserMessages } from "./session-domain"

const user = (id: string): SessionMessageUser => ({
  id,
  type: "user",
  text: id,
  time: { created: 0 },
})

const assistant: SessionMessageAssistant = {
  id: "msg_2",
  type: "assistant",
  time: { created: 0 },
  agent: "build",
  model: { id: "model", providerID: "provider" },
  content: [],
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
}

test("selects user history strictly before the revert boundary", () => {
  const messages: SessionMessageInfo[] = [user("msg_a"), assistant, user("msg_b"), user("msg_c")]
  const users = selectSessionUserMessages(messages)

  expect(users.map((message) => message.id)).toEqual(["msg_a", "msg_b", "msg_c"])
  expect(selectVisibleSessionUserMessages(messages, "msg_b").map((message) => message.id)).toEqual(["msg_a"])
  expect(selectVisibleSessionUserMessages(messages.slice(3), "msg_b")).toEqual([])
  expect(selectVisibleSessionUserMessages(messages)).toEqual(users)
  // A boundary that is not a user message still hides the users after it.
  expect(selectVisibleSessionUserMessages(messages, "msg_2").map((message) => message.id)).toEqual(["msg_a"])
})

test("finds the revert boundary by position, since fork copy ids do not sort in history order", () => {
  const messages = [user("msg_X_3"), user("msg_X_12"), user("msg_X_100")]

  expect(selectVisibleSessionUserMessages(messages, "msg_X_12").map((message) => message.id)).toEqual(["msg_X_3"])
  expect(selectVisibleSessionUserMessages(messages, "msg_X_100").map((message) => message.id)).toEqual([
    "msg_X_3",
    "msg_X_12",
  ])
})
