import {
  existsSync,
  lstatSync,
  readFileSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";

import { parse, stringify } from "smol-toml";

import { codexHomePath } from "../runtime/codex-home.mjs";
import { writePrivateFileAtomicSync } from "../runtime/private-file.mjs";

const layoutVersion = 1;

export function migrateManagedModelProviderFiles(environment = process.env) {
  const codexHome = codexHomePath(environment);
  const paths = migrationPaths(codexHome);
  const existingLegacy = paths.filter(({ legacy }) => existsSync(legacy));
  if (existingLegacy.length === 0) return { changed: false, layoutVersion, moved: [] };
  for (const { legacy, current } of existingLegacy) {
    assertPrivateRegularFile(legacy);
    if (existsSync(current)) {
      throw new Error(`第三方 Provider 新旧文件同时存在，拒绝迁移：${legacy}、${current}`);
    }
  }
  const snapshots = snapshotPaths([
    ...paths.flatMap(({ legacy, current }) => [legacy, current]),
    join(codexHome, "config.toml"),
  ]);
  try {
    const oldCatalogPath = join(codexHome, "deepseek.models.json");
    const newCatalogPath = join(codexHome, "sf-deepseek.models.json");
    const oldRolePath = join(codexHome, "codex-connect-third-party-subagent.config.toml");
    const newRolePath = join(codexHome, "sf-agent.config.toml");
    for (const { legacy, current } of existingLegacy) {
      const content = rewriteManagedTomlReferences(
        readFileSync(legacy, "utf8"),
        oldCatalogPath,
        newCatalogPath,
      );
      writePrivateFileAtomicSync(current, content);
    }
    rewriteRootConfigReferences(
      join(codexHome, "config.toml"),
      oldCatalogPath,
      newCatalogPath,
      oldRolePath,
      newRolePath,
    );
    for (const { legacy } of existingLegacy) unlinkSync(legacy);
    return {
      changed: true,
      layoutVersion,
      moved: existingLegacy.map(({ legacy, current }) => ({ legacy, current })),
    };
  } catch (error) {
    restoreSnapshots(snapshots);
    throw error;
  }
}

function migrationPaths(codexHome) {
  const deepseekBackup = join(codexHome, "backup-codex-connect-deepseek");
  const openCodeBackup = join(codexHome, "backup-codex-connect-opencode-go");
  return [
    ["deepseek.config.toml", "sf-deepseek.config.toml"],
    ["opencode-go.config.toml", "sf-opencode-go.config.toml"],
    ["deepseek.models.json", "sf-deepseek.models.json"],
    ["deepseek.models.manifest.json", "sf-deepseek.models.manifest.json"],
    ["codex-connect-deepseek.config.toml", "sf-deepseek.managed.toml"],
    ["codex-connect-opencode-go.config.toml", "sf-opencode-go.managed.toml"],
    ["codex-connect-third-party-subagent.config.toml", "sf-agent.config.toml"],
  ].map(([legacy, current]) => ({
    legacy: join(codexHome, legacy),
    current: join(codexHome, current),
  })).concat([
    {
      legacy: join(deepseekBackup, "deepseek.config.toml"),
      current: join(deepseekBackup, "sf-deepseek.config.toml"),
    },
    {
      legacy: join(deepseekBackup, "codex-connect-deepseek.config.toml"),
      current: join(deepseekBackup, "sf-deepseek.managed.toml"),
    },
    {
      legacy: join(deepseekBackup, "codex-connect-third-party-subagent.config.toml"),
      current: join(deepseekBackup, "sf-agent.config.toml"),
    },
    {
      legacy: join(openCodeBackup, "opencode-go.config.toml"),
      current: join(openCodeBackup, "sf-opencode-go.config.toml"),
    },
    {
      legacy: join(openCodeBackup, "codex-connect-opencode-go.config.toml"),
      current: join(openCodeBackup, "sf-opencode-go.managed.toml"),
    },
    {
      legacy: join(openCodeBackup, "codex-connect-third-party-subagent.config.toml"),
      current: join(openCodeBackup, "sf-agent.config.toml"),
    },
  ]);
}

function rewriteManagedTomlReferences(content, oldCatalogPath, newCatalogPath) {
  let document;
  try {
    document = parse(content);
  } catch {
    return content;
  }
  if (document.model_catalog_json !== oldCatalogPath) return content;
  document.model_catalog_json = newCatalogPath;
  return stringify(document);
}

function rewriteRootConfigReferences(
  configPath,
  oldCatalogPath,
  newCatalogPath,
  oldRolePath,
  newRolePath,
) {
  if (!existsSync(configPath)) return;
  assertPrivateRegularFile(configPath, { allowGroupRead: true });
  let document;
  try {
    document = parse(readFileSync(configPath, "utf8"));
  } catch {
    throw new Error("Codex config.toml 无法安全解析，未迁移第三方 Provider 文件");
  }
  let changed = false;
  if (document.model_catalog_json === oldCatalogPath) {
    document.model_catalog_json = newCatalogPath;
    changed = true;
  }
  const agents = record(document.agents);
  const external = record(agents.external);
  if (external.config_file === oldRolePath) {
    external.config_file = newRolePath;
    agents.external = external;
    document.agents = agents;
    changed = true;
  }
  if (changed) writePrivateFileAtomicSync(configPath, stringify(document));
}

function assertPrivateRegularFile(path, { allowGroupRead = false } = {}) {
  const status = lstatSync(path);
  const currentUid = process.getuid?.();
  const forbiddenMode = allowGroupRead ? 0o022 : 0o077;
  if (
    !status.isFile()
    || status.isSymbolicLink()
    || (status.mode & forbiddenMode) !== 0
    || (currentUid !== undefined && status.uid !== currentUid)
  ) {
    throw new Error(`第三方 Provider 文件权限或类型不安全：${path}`);
  }
}

function snapshotPaths(paths) {
  return [...new Set(paths)].map((path) => ({
    path,
    content: existsSync(path) ? readFileSync(path) : undefined,
  }));
}

function restoreSnapshots(snapshots) {
  for (const { path, content } of snapshots) {
    if (content === undefined) {
      if (existsSync(path)) unlinkSync(path);
    } else {
      writePrivateFileAtomicSync(path, content);
    }
  }
}

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
}
