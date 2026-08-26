import { existsSync, unlinkSync } from "node:fs";
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
import {
  readPrivateFileSync,
  writePrivateFileAtomic,
} from "../runtime/private-file.mjs";

const maximumPrivateConfigBytes = 2_097_152;

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

export async function readOptionalOpencodeGoFile(path) {
  try {
    return Buffer.from(readPrivateFileSync(path, maximumPrivateConfigBytes));
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

export async function replaceOptionalOpencodeGoFile(path, content) {
  if (content === undefined) return removeOptionalOpencodeGoFile(path);
  await writePrivateFileAtomic(path, content);
}

export async function removeOptionalOpencodeGoFile(path) {
  try {
    unlinkSync(path);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

export function snapshotOpencodeGoFiles(paths) {
  return [...new Set(paths)].map((path) => ({
    path,
    content: existsSync(path)
      ? Buffer.from(readPrivateFileSync(path, maximumPrivateConfigBytes))
      : undefined,
  }));
}

export async function restoreOpencodeGoFileSnapshots(snapshots, guards) {
  for (const guard of guards) {
    const current = await readOptionalOpencodeGoFile(guard.path);
    if (!sameOptionalContent(current, guard.content)) {
      throw new Error(`OpenCode Go 配置文件在事务期间发生变化：${guard.path}`);
    }
  }
  for (const snapshot of snapshots) {
    await replaceOptionalOpencodeGoFile(snapshot.path, snapshot.content);
  }
}

function sameOptionalContent(left, right) {
  if (left === undefined || right === undefined) return left === right;
  return left.equals(right);
}
