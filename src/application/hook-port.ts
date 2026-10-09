export type HookAction = "trust" | "enable" | "disable";

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

/** Surface-owned review fidelity check, re-evaluated before every trust operation. */
export type HookReviewPolicy = (surface: string, hook: HookEntry) => boolean;

export interface HookConfigPort {
  listHooks(cwd: string, modelProvider: string): Promise<HookCatalog>;
  readHookConfigVersion(modelProvider: string): Promise<string>;
  writeHookState(modelProvider: string, input: {
    key: string;
    currentHash: string;
    action: HookAction;
    expectedVersion: string;
  }): Promise<{ refreshFailedProviders: string[] }>;
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
  confirmation?: { token: string; action: HookAction };
  updated?: HookAction;
  refreshFailedProviders?: string[];
}
