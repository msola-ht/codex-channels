export interface CodexUserConfigEdit {
  keyPath: string;
  value: unknown;
}

export type CodexUserConfigWriter = (
  environment: NodeJS.ProcessEnv,
  createEdits: (config: Record<string, unknown>) => CodexUserConfigEdit[],
) => Promise<void>;

export interface AgentsStatus {
  configPath: string;
  roleConfigPath: string;
  multiAgentV2Enabled: boolean;
  dsRoleConfigured: boolean;
}

export function agentsStatus(environment?: NodeJS.ProcessEnv): AgentsStatus;
export function assertDeepseekRoleAvailable(environment?: NodeJS.ProcessEnv): void;
export function enableDeepseekRole(
  environment?: NodeJS.ProcessEnv,
  dependencies?: { updateConfig?: CodexUserConfigWriter },
): Promise<void>;
export function disableDeepseekRole(
  environment?: NodeJS.ProcessEnv,
  dependencies?: { updateConfig?: CodexUserConfigWriter },
): Promise<void>;
export function removeManagedDeepseekRole(
  environment?: NodeJS.ProcessEnv,
  dependencies?: { updateConfig?: CodexUserConfigWriter },
): Promise<void>;
