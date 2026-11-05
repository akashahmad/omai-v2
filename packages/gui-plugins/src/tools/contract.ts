// What other built-ins may reuse from the Tools plugin: pure helpers over the publishing status, and the token that opens
// a tool. The preview's Publish dialog reads them, so its stepper, address and times match the Publishing tool's.

import { Contract, type SessionRef } from "@opencode/plugin/gui"

export { pill, type Pill } from "./domains/model"

export { ago, duration, liveAddress, primaryDomain, slug, stepState, STEPS, type Step, type StepState } from "./publish/model"

/** A tool in the Tools section. */
export type ToolId = "publish" | "domains" | "seo" | "checkpoints" | "git"

/** The Tools section of the side panel. */
export interface Tools {
  /**
   * Shows the Tools section of a session's side panel on one tool.
   *
   * @param session - The session whose side panel opens.
   * @param tool - The tool to show.
   */
  open(session: SessionRef, tool: ToolId): void
}

/** The Tools plugin provides this, so other built-ins can send the user to a tool, such as Domains. */
export const Tools = Contract.define<Tools, "tools.open">("tools.open")
