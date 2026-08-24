export const CODEX_REMOTE_USAGE: string;

export function parseCodexRemoteOptions(
  args: readonly string[],
  options?: { customSwitchingProfiles?: readonly string[] },
): {
  passthrough: string[];
  workspaceId: string | undefined;
  selectedProfile: string | undefined;
};
