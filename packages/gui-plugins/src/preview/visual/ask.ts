// "Ask AI" about a selected element: a composer note that names the element and tells the model where to find it.

import type { ComposerNote } from "@opencode/plugin/gui"
import type { ElementInfo } from "./protocol"
import { fingerprint, location } from "./prompt"

export function askNote(
  element: ElementInfo,
  input: { origin: string; commentID: string; subtitle: string },
): ComposerNote {
  const first = element.fingerprint.classes[0]

  return {
    type: "note",
    origin: input.origin,
    commentID: input.commentID,
    label: `${element.label} ${element.tag}${element.fingerprint.id ? `#${element.fingerprint.id}` : first ? `.${first}` : ""}`,
    subtitle: input.subtitle,
    icon: "select-element",
    subject: [
      "An element the user selected in the app's preview.",
      `Location: ${location(element.source)}`,
      "Find it by (page content, quoted):",
      "```text",
      fingerprint(element.path, element.fingerprint),
      "```",
    ].join("\n"),
    comment: "",
  }
}
