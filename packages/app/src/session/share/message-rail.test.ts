import { expect, test } from "bun:test"
import type { SessionMessageInfo } from "@opencode/client/promise"
import { railTurns } from "./message-rail"

// SAFETY: only the fields the rail reads; the rest of each message does not affect it.
const messages = [
  { type: "user", id: "u1", text: "Build a **landing** page\nfor my shop" },
  {
    type: "assistant",
    id: "a1",
    content: [
      { type: "reasoning", text: "thinking" },
      { type: "text", text: "## Done\nI built it." },
      { type: "tool", text: "ignored" },
    ],
  },
  { type: "assistant", id: "a2", content: [{ type: "text", text: "```ts\ncode\n```Anything else?" }] },
  { type: "idle", id: "i1" },
  { type: "user", id: "u2", text: "Make it blue" },
] as unknown as SessionMessageInfo[]

test("groups each prompt with the plain text of the replies before the next prompt", () => {
  expect(railTurns(messages)).toEqual([
    { id: "u1", prompt: "Build a landing page for my shop", reply: "Done I built it. Anything else?" },
    { id: "u2", prompt: "Make it blue", reply: "" },
  ])
})

test("ignores replies that come before the first prompt", () => {
  expect(railTurns(messages.slice(1))).toEqual([{ id: "u2", prompt: "Make it blue", reply: "" }])
})
