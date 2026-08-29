export const CODEX_REMOTE_USAGE: string;

export function parseCodexRemoteOptions(
  args: readonly string[],
  options?: {
    environment?: NodeJS.ProcessEnv;
    managedProfileDefinitions?: ReadonlyArray<{
      id: string;
      profileName: string;
    }>;
    customSwitchingProfiles?: ReadonlyArray<{
      providerId: string;
      profileName: string;
    }>;
  },
): {
  passthrough: string[];
  workspaceId: string | undefined;
  selectedProfile: string | undefined;
};
