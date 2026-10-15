export type WorkspaceDirectoryInspection =
  | { valid: true; status: "available"; cwd: string }
  | { valid: false; status: "missing" | "not-directory" | "inaccessible"; detail: string };

export function inspectWorkspaceDirectory(cwd: string): WorkspaceDirectoryInspection;
