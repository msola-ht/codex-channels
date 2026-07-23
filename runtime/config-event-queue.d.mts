export interface QueuedWorkspace {
  id: string;
  name: string;
  cwd: string;
}

export interface WorkspaceAddedConfigEvent {
  version: 1;
  id: string;
  type: "workspace-added";
  createdAt: string;
  workspace: QueuedWorkspace;
}

export function configEventQueuePath(dataDir: string): string;
export function enqueueWorkspaceAdded(
  queuePath: string,
  workspace: QueuedWorkspace,
): WorkspaceAddedConfigEvent;
export function readConfigEvents(queuePath: string): WorkspaceAddedConfigEvent[];
export function matchingWorkspaceConfigEvents(
  events: readonly WorkspaceAddedConfigEvent[],
  workspaces: readonly QueuedWorkspace[],
): WorkspaceAddedConfigEvent[];
export function acknowledgeConfigEvents(queuePath: string, eventIds: Iterable<string>): void;
export function discardWorkspaceConfigEvents(
  queuePath: string,
  workspaceIds: Iterable<string>,
): void;
