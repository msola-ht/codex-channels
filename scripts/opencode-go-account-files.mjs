import { join } from "node:path";

import { codexHomePath } from "../runtime/codex-home.mjs";
import { opencodeGoAccountDefinition } from "../runtime/model-provider-definitions.mjs";
import {
  managedModelProviderRoleConfigPath,
  managedProviderDirectory,
} from "../runtime/model-provider-runtime.mjs";
import {
  opencodeGoAccountBackupDirectory,
  opencodeGoAccountDirectory,
  opencodeGoAccountMarkerPath,
} from "../runtime/opencode-go-accounts.mjs";

export function opencodeGoAccountPaths(environment, accountId) {
  const codexHome = codexHomePath(environment);
  const definition = opencodeGoAccountDefinition(accountId);
  const providerDirectory = managedProviderDirectory(environment, definition);
  return {
    codexHome,
    providerDirectory,
    accountDirectory: opencodeGoAccountDirectory(environment, accountId),
    backupDirectory: opencodeGoAccountBackupDirectory(environment, accountId),
    configPath: join(codexHome, "config.toml"),
    profilePath: join(codexHome, definition.profileFileName),
    markerPath: opencodeGoAccountMarkerPath(environment, accountId),
    catalogPath: join(providerDirectory, definition.catalogFileName),
    manifestPath: join(providerDirectory, definition.catalogManifestFileName),
    roleConfigPath: managedModelProviderRoleConfigPath(environment),
  };
}

export function opencodeGoProfileFileName(accountId) {
  return opencodeGoAccountDefinition(accountId).profileFileName;
}
