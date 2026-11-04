import { containsDirectory, sameDirectory } from "@opencode/util/path"
import type { WorktreeDirectory } from "@opencode/client/promise"

type WorkspaceProject = {
  worktree: string
  sandboxes?: readonly string[]
  worktrees?: readonly WorktreeDirectory[]
}

export function workspaceDirectories(project: WorkspaceProject) {
  return (project.sandboxes ?? []).filter((directory) => !sameDirectory(project.worktree, directory))
}

export function isWorkspaceDirectory(project: WorkspaceProject | undefined, directory: string) {
  if (!project || sameDirectory(project.worktree, directory)) return false

  return workspaceDirectories(project).some((workspace) => containsDirectory(workspace, directory))
}

export function isProjectDirectory(project: WorkspaceProject | undefined, directory: string) {
  if (!project) return false

  return [project.worktree, ...(project.sandboxes ?? [])].some((root) => containsDirectory(root, directory))
}

export function workspaceSelectionDestination(selection: string, projectWorktree: string) {
  return selection === "main" || sameDirectory(selection, projectWorktree) ? "main" : "create"
}
