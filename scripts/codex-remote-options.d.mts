export const CODEX_REMOTE_USAGE: string;

export function parseCodexRemoteOptions(
  args: readonly string[],
  options?: {
    customSwitchingProfiles?: ReadonlyArray<{
      profileName: string;
      codexProfileName: string;
    }>;
  },
): {
  passthrough: string[];
  workspaceId: string | undefined;
  selectedProfile: string | undefined;
};
