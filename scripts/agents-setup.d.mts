export interface ThirdPartyAgentSetupProvider {
  provider: string;
  displayName: string;
  model: string;
  reasoningEffort: string;
  mode: "switching" | "exclusive";
  models: Array<{
    model: string;
    displayName: string;
    contextWindow: number;
    reasoningEffort: string;
    reasoningEfforts: Array<{ effort: string; description: string }>;
  }>;
}

export function runThirdPartyAgentSetup(options?: {
  allowBack?: boolean;
  environment?: NodeJS.ProcessEnv;
  input?: NodeJS.ReadableStream;
  output?: { write(value: string): boolean };
  prompts?: {
    select(options: Record<string, unknown>): Promise<unknown>;
    confirm(options: Record<string, unknown>): Promise<unknown>;
    isCancel(value: unknown): boolean;
  };
  loadProviders?: typeof loadThirdPartyAgentSetupProviders;
  loadStatus?: typeof import("./agents.mjs").agentsStatus;
  configureRole?: typeof import("./agents.mjs").configureThirdPartyRole;
  disableRole?: typeof import("./agents.mjs").disableThirdPartyRole;
}): Promise<
  | { action: "back" }
  | { action: "disabled" }
  | { action: "configured"; provider: string; model: string }
>;
export function loadThirdPartyAgentSetupProviders(
  environment?: NodeJS.ProcessEnv,
): ThirdPartyAgentSetupProvider[];
