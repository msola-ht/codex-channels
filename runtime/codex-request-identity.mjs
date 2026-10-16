import { readFileSync } from "node:fs";
import { officialTuiUserAgentPattern } from "./gateway-config.mjs";

const metadata = JSON.parse(readFileSync(new URL("../src/codex-protocol/version.json", import.meta.url), "utf8"));
export const officialTuiClientVersion = metadata.codexCli.replace(/^codex-cli\s+/u, "");

/** Resolve validated configuration without mutation; consumers validate the derived UA before use. */
export function resolveCodexRequestIdentity(codex) {
  const identity = codex.client_identity;
  if (codex.follow_cli_version !== true) {
    return { clientIdentity: identity, upstreamUserAgent: codex.upstream_user_agent };
  }
  const clientIdentity = identity
    ? { ...identity, version: officialTuiClientVersion }
    : identity;
  const configured = codex.upstream_user_agent;
  const match = configured === undefined ? null : officialTuiUserAgentPattern.exec(configured);
  const upstreamUserAgent = match
    ? `codex-tui/${officialTuiClientVersion} ${match[2]} (codex-tui; ${officialTuiClientVersion})`
    : configured;
  return { clientIdentity, upstreamUserAgent };
}
