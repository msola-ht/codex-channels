export interface ConfiguredAgentRole {
  name: string;
  description: string | null;
}

export function agentRolesConfigPath(
  environment?: NodeJS.ProcessEnv,
): string;

export function listConfiguredAgentRoles(
  environment?: NodeJS.ProcessEnv,
): ConfiguredAgentRole[];
