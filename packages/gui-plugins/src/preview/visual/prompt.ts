// The prompt Save sends to the session's agent: every pending visual change, grouped by element, with where to find
// the element in the source and the rules for making the change the project's own way. Page content (element text,
// attributes) only appears quoted in fenced blocks, so the agent never reads it as instructions.

import { grouped } from "./changes"
import type { Fingerprint, LiveChange, SourceHint } from "./protocol"

const RULES = [
  "- Make each change in the project's source code, using the project's own styling approach (Tailwind classes, CSS modules, styled components or plain CSS: whichever the element already uses).",
  "- Keep the layout responsive; don't hard-code sizes that break other screen widths unless the change asks for that exact size.",
  "- Don't add inline styles or `!important` unless the project already uses them for this element.",
  "- Change only the listed elements and properties. Don't refactor or restyle anything else.",
  "- For a move, move the element in the markup; don't fake it with CSS order or positioning.",
  "- The changes are already visible in the preview, so you don't need to check them visually.",
  "- When you're done, list anything you could not apply, and why.",
]

export function savePrompt(input: { page: string; items: readonly LiveChange[]; hints: ReadonlyMap<string, SourceHint | undefined> }) {
  const blocks = grouped(input.items).map((group, index) => {
    const first = group.changes[0]!

    return [
      `### ${index + 1}. ${describe(first.fingerprint)}`,
      `Location: ${location(input.hints.get(group.path))}`,
      "Find it by (page content, quoted):",
      "```text",
      fingerprint(group.path, first.fingerprint),
      "```",
      "Changes:",
      ...group.changes.map((change) => `- ${line(change)}`),
    ].join("\n")
  })

  return [
    `Apply these visual edits I made in the preview of ${input.page} to the project's source code.`,
    "",
    ...blocks.flatMap((block) => [block, ""]),
    "Rules:",
    ...RULES,
  ].join("\n")
}

const describe = (value: Fingerprint) =>
  `<${value.tag}${value.id ? `#${value.id}` : ""}${value.classes.slice(0, 3).map((name) => `.${name}`).join("")}>`

/** Where the element is in the source, as far as the framework says. */
export function location(hint: SourceHint | undefined) {
  if (!hint?.file && !hint?.component) return "not known; search the source for the element below."
  const file = hint.file ? `${hint.file}${hint.line ? `:${hint.line}` : ""}` : "component"

  return hint.component ? `${file} (${hint.component})` : file
}

/** How to find the element; page content, for a fenced `text` block. */
export function fingerprint(path: string, value: Fingerprint) {
  return [
    `selector: ${path}`,
    `tag: ${value.tag}`,
    ...(value.id ? [`id: ${value.id}`] : []),
    ...(value.classes.length ? [`classes: ${value.classes.join(" ")}`] : []),
    ...(value.text ? [`text: ${JSON.stringify(value.text)}`] : []),
    ...Object.entries(value.attrs).map(([name, attr]) => `${name}: ${JSON.stringify(attr)}`),
  ]
    .join("\n")
    .replaceAll("```", "'''")
}

function line(change: LiveChange) {
  if (change.kind === "text") return `text: ${JSON.stringify(change.before)} → ${JSON.stringify(change.after)}`

  if (change.kind === "move") return `moved from position ${change.before} to ${change.after} among its siblings`

  if (change.kind === "attribute") return `${change.property} attribute: ${JSON.stringify(change.before)} → ${JSON.stringify(change.after)}`

  return `${change.property}: ${change.before || "(not set)"} → ${change.after}`
}
