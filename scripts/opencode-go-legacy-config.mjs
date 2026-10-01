import { existsSync } from "node:fs";
import { join } from "node:path";
import { parse } from "smol-toml";

import { codexHomePath } from "../runtime/codex-home.mjs";
import { opencodeGoProviderDefinition } from "../runtime/model-provider-definitions.mjs";
import { managedProviderDirectory } from "../runtime/model-provider-runtime.mjs";
import {
  loadOpencodeGoAccounts,
  opencodeGoAccountMarkerPath,
  validateOpencodeGoAccountId,
} from "../runtime/opencode-go-accounts.mjs";
import { readPrivateFileSync } from "../runtime/private-file.mjs";

export function readLegacyOpencodeGoToml(path) {
  if (!existsSync(path)) return {};
  try { return parse(readPrivateFileSync(path, 2_097_152)); }
  catch { throw new Error("OpenCode Go 旧配置无法安全读取"); }
}

export function hasLegacyOpencodeGoConfiguration(environment = process.env, accountId) {
  const directory = managedProviderDirectory(environment, opencodeGoProviderDefinition);
  if (accountId === undefined) return existsSync(join(directory, "managed.toml"));
  validateOpencodeGoAccountId(accountId);
  const marker = readLegacyOpencodeGoToml(opencodeGoAccountMarkerPath(environment, accountId));
  const home = codexHomePath(environment);
  return ["opencode-go", `opencode-go-${accountId}`].includes(marker.provider)
    || existsSync(join(home, `sf-opencode-go-${accountId}.config.toml`))
    || (loadOpencodeGoAccounts(environment).some((account) => account.id === accountId && account.default)
      && existsSync(join(home, "sf-opencode-go.config.toml"))
      && readLegacyOpencodeGoToml(join(home, "sf-opencode-go.config.toml")).model_provider === marker.provider);
}
