import type { GatewayConfigDocument } from "./gateway-config.mjs";

export const officialTuiClientVersion: string;
export function resolveCodexRequestIdentity(
  codex: Pick<GatewayConfigDocument["codex"], "client_identity" | "upstream_user_agent" | "follow_cli_version">,
): {
  clientIdentity: GatewayConfigDocument["codex"]["client_identity"];
  upstreamUserAgent: string | undefined;
};
