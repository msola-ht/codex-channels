import type { ConversationCommandResult } from "../application/index.js";

type WorkspacesResult = Extract<ConversationCommandResult, { kind: "workspaces" }>;

/** Raw identities and display data; escaping, pagination and authorization stay with their owners. */
export function createWorkspaceSelectionPresentation(result: WorkspacesResult) {
  const entries = result.workspaces.map((workspace, index) => ({
    id: workspace.id,
    name: workspace.name,
    cwd: workspace.cwd,
    position: index + 1,
    isCurrent: workspace.id === result.currentWorkspaceId,
  }));
  return {
    currentWorkspaceId: result.currentWorkspaceId,
    currentWorkspace: entries.find(entry => entry.isCurrent),
    entries,
  };
}
