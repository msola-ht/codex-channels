import type { ManagedModelProviderId } from "../runtime/model-provider-definitions.mjs";
import type {
  CodexUserConfigEdit,
  CodexUserConfigValue,
} from "./codex-user-config.mjs";

export type CodexUserConfigWriter = (
  environment: NodeJS.ProcessEnv,
  createEdits: (
    config: Record<string, CodexUserConfigValue | undefined>,
  ) => CodexUserConfigEdit[],
) => Promise<void>;

export interface AgentsStatus {
  configPath: string;
  roleConfigPath: string;
  multiAgentV2Enabled: boolean;
  externalRoleConfigured: boolean;
  legacyDsRoleConfigured: boolean;
  provider?: ManagedModelProviderId;
  model?: string;
}

export function agentsStatus(environment?: NodeJS.ProcessEnv): AgentsStatus;
export function assertThirdPartyRoleAvailable(environment?: NodeJS.ProcessEnv): void;
export function configureThirdPartyRole(
  provider: ManagedModelProviderId,
  model?: string,
  environment?: NodeJS.ProcessEnv,
  dependencies?: { updateConfig?: CodexUserConfigWriter },
): Promise<{ role: "external"; provider: ManagedModelProviderId; model: string }>;
export function disableThirdPartyRole(
  environment?: NodeJS.ProcessEnv,
  dependencies?: { updateConfig?: CodexUserConfigWriter },
): Promise<boolean>;
export function removeManagedThirdPartyRole(
  environment?: NodeJS.ProcessEnv,
  dependencies?: {
    updateConfig?: CodexUserConfigWriter;
    provider?: ManagedModelProviderId;
    disableFeature?: boolean;
  },
): Promise<boolean>;
