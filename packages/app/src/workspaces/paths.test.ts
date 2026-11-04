import { describe, expect, test } from "bun:test"
import { isWorkspaceDirectory, workspaceSelectionDestination } from "./paths"
import { withWorktreeInventory } from "./inventory"
import { pathKey } from "./path-key"
import { normalizeProjectInfo } from "@/runtime/server/global-sync/utils"

describe("isWorkspaceDirectory", () => {
  const project = {
    worktree: "C:\\repo\\",
    sandboxes: ["C:\\repo-workspaces\\feature\\", "C:\\repo-workspaces\\other"],
  }

  test("distinguishes managed workspaces from the local repository", () => {
    expect(isWorkspaceDirectory(project, "C:\\repo")).toBe(false)
    expect(isWorkspaceDirectory(project, "C:\\repo-workspaces\\feature")).toBe(true)
    expect(isWorkspaceDirectory(project, "c:\\repo-workspaces\\feature\\packages\\app")).toBe(true)
    expect(
      isWorkspaceDirectory({ worktree: "/repo", sandboxes: ["/repo/.worktrees/feature"] }, "/repo/.worktrees/feature"),
    ).toBe(true)
    expect(isWorkspaceDirectory(project, "C:\\other")).toBe(false)
    expect(isWorkspaceDirectory(undefined, "C:\\repo-workspaces\\feature")).toBe(false)
  })

  const root = "C:/OpenCode/WorkspaceAccent"

  const inventoried = withWorktreeInventory(
    normalizeProjectInfo({
      id: "project",
      canonical: root,
      time: { created: 1, updated: 1, active: 1 },
      sandboxes: [],
    }),
    [
      { directory: root },
      { directory: `${root}/.worktrees/feature`, strategy: "git" },
      { directory: "C:/OpenCode/WorkspaceCopy", strategy: "copy" },
      { directory: "C:/OpenCode/RegisteredDirectory" },
    ],
  )

  test.each([
    { name: "nested main directory", directory: `${root}/packages/app`, expected: false },
    { name: "unregistered sibling with the same prefix", directory: `${root}/.worktrees/feature-x`, expected: false },
    { name: "workspace using another strategy", directory: "C:/OpenCode/WorkspaceCopy", expected: true },
    { name: "registered directory without a strategy", directory: "C:/OpenCode/RegisteredDirectory", expected: true },
  ])("classifies an inventoried $name", ({ directory, expected }) => {
    expect(isWorkspaceDirectory(inventoried, directory)).toBe(expected)
  })
})

test.each([
  ["/tmp/demo///", "/tmp/demo"],
  ["C:\\tmp\\demo\\\\", "C:/tmp/demo"],
  ["/", "/"],
  ["///", "/"],
  ["C:\\", "C:/"],
  ["C://", "C:/"],
  ["C:///", "C:/"],
])("pathKey(%p) is %p", (input, expected) => {
  expect(String(pathKey(input))).toBe(expected)
})

describe("workspaceSelectionDestination", () => {
  test("keeps local intent for main and the project root, otherwise creates a workspace", () => {
    expect(workspaceSelectionDestination("main", "/repo")).toBe("main")
    expect(workspaceSelectionDestination("/repo/", "/repo")).toBe("main")
    expect(workspaceSelectionDestination("c:\\repo\\", "C:\\repo")).toBe("main")
    expect(workspaceSelectionDestination("create", "/repo")).toBe("create")
    expect(workspaceSelectionDestination("/workspaces/feature", "/repo")).toBe("create")
  })
})
