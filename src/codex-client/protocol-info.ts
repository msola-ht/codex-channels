import { protocolVersion } from "../codex-protocol/index.js";

export const codexConnectIntegrationId = "codex_connect";
export const supportedCodexCliVersion = protocolVersion.codexCli;
export const gatewayVersion = supportedCodexCliVersion.replace(
  /^codex-cli\s+/,
  "",
);
