import type { CodexUserConfigTransactionClient } from "./codex-user-config.mjs";

export function writePrimaryProviderConfigEditsWithProfileRemoval(options: {
  environment: NodeJS.ProcessEnv;
  providerId?: string;
  switchingProvider?: {
    id: string;
    profileContent: string;
  };
  edits: Array<{ keyPath: string; value: unknown }>;
  expectedVersion?: string | number | null;
  createClient: (options: {
    environment: NodeJS.ProcessEnv;
  }) => Promise<CodexUserConfigTransactionClient>;
}): Promise<void>;
