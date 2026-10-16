import { readFileSync } from "node:fs";

const metadata = JSON.parse(readFileSync(new URL("../src/codex-protocol/version.json", import.meta.url), "utf8"));
export const officialTuiClientVersion = metadata.codexCli.replace(/^codex-cli\s+/u, "");

// Only the complete official shape with matching version tokens follows the CLI.
// Other overrides retain their literal meaning, including mixed client identities.
const officialUserAgent = /^codex-tui\/([0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9._+-]+)?) (\([^();\r\n]+; [A-Za-z0-9_+-]+\) [A-Za-z0-9._/-]+) \(codex-tui; \1\)$/u;

/** Resolve validated configuration without mutation; consumers validate the derived UA before use. */
export function resolveCodexRequestIdentity(codex) {
  const identity = codex.client_identity;
  const clientIdentity = identity && (identity.name ?? "codex-tui") === "codex-tui"
    ? { ...identity, version: officialTuiClientVersion }
    : identity;
  const configured = codex.upstream_user_agent;
  const match = configured === undefined ? null : officialUserAgent.exec(configured);
  const upstreamUserAgent = match
    ? `codex-tui/${officialTuiClientVersion} ${match[2]} (codex-tui; ${officialTuiClientVersion})`
    : configured;
  return { clientIdentity, upstreamUserAgent };
}
