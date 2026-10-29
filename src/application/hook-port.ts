export type HookAction = "trust" | "enable" | "disable";
export type HookWriteInput = { expectedVersion: string } & (
  | { action: HookAction; key: string; currentHash: string }
  | { action: "trust-all"; hooks: Array<{ key: string; currentHash: string }> }
);

export interface HookEntry {
  key: string;
  eventName: string;
  matcher: string | null;
  handlerType: "command" | "mcpTool" | "prompt" | "agent";
  timeoutSec: number;
  async: boolean | null;
  additionalContextLimit: number | null;
  description: string;
  source: string;
  sourcePath: string;
  enabled: boolean;
  isManaged: boolean;
  currentHash: string;
  trustStatus: "managed" | "untrusted" | "trusted" | "modified";
  reviewable: boolean;
}

export interface HookCatalog {
  hooks: HookEntry[];
  warningCount: number;
  errorCount: number;
}

export type HookStartupSummary =
  | { kind: "available"; untrusted: number; modified: number; warningCount: number; errorCount: number }
  | { kind: "unavailable" };

/** Surface-owned review fidelity check, re-evaluated before individual trust operations. */
export type HookReviewPolicy = (surface: string, hook: HookEntry) => boolean;

export interface HookConfigPort {
  listHooks(cwd: string, modelProvider: string, beforeSubmit?: () => void, signal?: AbortSignal): Promise<HookCatalog>;
  readHookConfigVersion(modelProvider: string, beforeSubmit?: () => void): Promise<string>;
  writeHookState(modelProvider: string, input: HookWriteInput, beforeSubmit?: () => void): Promise<{ refreshFailedProviders: string[] }>;
}

export interface HookCommandView {
  workspaceId: string;
  provider: string;
  entries: Array<{ selector: string; hook: HookEntry }>;
  warningCount: number;
  errorCount: number;
  page: number;
  pageCount: number;
  detail?: { selector: string; hook: HookEntry };
  confirmation?: { token: string; action: HookAction | "trust-all" };
  updated?: HookAction | "trust-all";
  bulkCount?: number;
  refreshFailedProviders?: string[];
}
