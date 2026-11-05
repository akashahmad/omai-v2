import type { SessionMessageInfo, SessionMessageUser } from "@opencode/client/promise"

export function selectSessionUserMessages(messages: SessionMessageInfo[]) {
  return messages.filter((message): message is SessionMessageUser => message.type === "user")
}

/**
 * The user messages before the revert boundary, read from the whole history in order. Fork copies have ids that do not
 * sort in history order, so the boundary is found by position. A boundary missing from the loaded window is older than
 * it, so nothing loaded is visible.
 */
export function selectVisibleSessionUserMessages(messages: SessionMessageInfo[], revertMessageID?: string) {
  if (!revertMessageID) return selectSessionUserMessages(messages)
  const boundary = messages.findIndex((message) => message.id === revertMessageID)

  return boundary < 0 ? [] : selectSessionUserMessages(messages.slice(0, boundary))
}
