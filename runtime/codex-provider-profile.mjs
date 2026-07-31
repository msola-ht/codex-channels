import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const gatewayDeepseekProfile = "codex-connect-deepseek";

export function gatewayCodexProfileArguments(environment = process.env) {
  const codexHome = resolve(environment.CODEX_HOME?.trim() || join(homedir(), ".codex"));
  const profilePath = join(codexHome, `${gatewayDeepseekProfile}.config.toml`);
  return existsSync(profilePath) ? ["--profile", gatewayDeepseekProfile] : [];
}
