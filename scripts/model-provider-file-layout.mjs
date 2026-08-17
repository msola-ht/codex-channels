import {
  existsSync,
  lstatSync,
  readFileSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";

import { parse, stringify } from "smol-toml";

import { codexHomePath } from "../runtime/codex-home.mjs";
import {
  deepseekProviderDefinition,
  managedModelProviderDefinitions,
} from "../runtime/model-provider-definitions.mjs";
import { writePrivateFileAtomicSync } from "../runtime/private-file.mjs";

const layoutVersion = 1;

export function migrateManagedModelProviderFiles(environment = process.env) {
  const codexHome = codexHomePath(environment);
  const paths = migrationPaths(codexHome);
  const existingLegacy = paths.filter(({ legacy }) => existsSync(legacy));
  if (existingLegacy.length === 0) return { changed: false, layoutVersion, moved: [] };
  const seenTargets = new Set();
  for (const { legacy, current } of existingLegacy) {
    assertPrivateRegularFile(legacy);
    if (seenTargets.has(current)) {
      throw new Error(`多个旧版文件指向同一目标，拒绝迁移：${current}`);
    }
    seenTargets.add(current);
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
    const legacyDsRolePath = join(codexHome, "codex-connect-ds-subagent.config.toml");
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
      legacyDsRolePath,
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

export function migrateManagedModelProviderModelSettings(environment = process.env) {
  const codexHome = codexHomePath(environment);
  const configured = managedModelProviderDefinitions.flatMap((definition) => {
    const markerPath = join(codexHome, definition.managedMarkerFileName);
    if (!existsSync(markerPath)) return [];
    assertPrivateRegularFile(markerPath);
    let marker;
    try {
      marker = parse(readFileSync(markerPath, "utf8"));
    } catch {
      throw new Error(`第三方 Provider 管理标记无法安全解析：${markerPath}`);
    }
    if (
      marker.version !== 1
      || marker.provider !== definition.id
      || !["switching", "exclusive"].includes(marker.mode)
    ) {
      throw new Error(`第三方 Provider 管理标记无效：${markerPath}`);
    }
    return [{ definition, mode: marker.mode }];
  });
  if (configured.length === 0) {
    return { changed: false, layoutVersion: 2, updated: [] };
  }
  const rolePath = join(codexHome, "sf-agent.config.toml");
  const paths = [
    ...configured.flatMap(({ definition, mode }) => [
      join(codexHome, mode === "exclusive" ? "config.toml" : definition.profileFileName),
      join(codexHome, definition.catalogFileName),
      join(codexHome, definition.catalogManifestFileName),
    ]),
    rolePath,
  ];
  const snapshots = snapshotPaths(paths);
  const updated = [];
  try {
    for (const item of configured) {
      updated.push(...prepareIndependentProviderCatalog(codexHome, item));
    }
    for (const item of configured) {
      updated.push(...migrateProviderModelSettings(codexHome, item));
    }
    if (existsSync(rolePath)) {
      updated.push(...migrateRoleModelSettings(codexHome, rolePath));
    }
    const uniqueUpdated = [...new Set(updated)];
    return { changed: uniqueUpdated.length > 0, layoutVersion: 2, updated: uniqueUpdated };
  } catch (error) {
    restoreSnapshots(snapshots);
    throw error;
  }
}

function prepareIndependentProviderCatalog(codexHome, { definition, mode }) {
  const configPath = join(
    codexHome,
    mode === "exclusive" ? "config.toml" : definition.profileFileName,
  );
  assertPrivateRegularFile(configPath, { allowGroupRead: mode === "exclusive" });
  const document = parseManagedToml(configPath);
  const sourceCatalogPath = typeof document.model_catalog_json === "string"
    ? document.model_catalog_json
    : undefined;
  if (sourceCatalogPath === undefined || !existsSync(sourceCatalogPath)) {
    throw new Error(`第三方 Provider 模型目录缺失：${configPath}`);
  }
  const updated = [];
  const expectedCatalogPath = join(codexHome, definition.catalogFileName);
  if (!existsSync(expectedCatalogPath)) {
    assertPrivateRegularFile(sourceCatalogPath);
    writePrivateFileAtomicSync(expectedCatalogPath, readFileSync(sourceCatalogPath));
    updated.push(expectedCatalogPath);
  }
  const expectedManifestPath = join(codexHome, definition.catalogManifestFileName);
  const sharedManifestPath = join(
    codexHome,
    deepseekProviderDefinition.catalogManifestFileName,
  );
  if (!existsSync(expectedManifestPath) && existsSync(sharedManifestPath)) {
    assertPrivateRegularFile(sharedManifestPath);
    writePrivateFileAtomicSync(expectedManifestPath, readFileSync(sharedManifestPath));
    updated.push(expectedManifestPath);
  }
  return updated;
}

function migrateProviderModelSettings(codexHome, { definition, mode }) {
  const configPath = join(
    codexHome,
    mode === "exclusive" ? "config.toml" : definition.profileFileName,
  );
  assertPrivateRegularFile(configPath, { allowGroupRead: mode === "exclusive" });
  const document = parseManagedToml(configPath);
  if (document.model_provider !== definition.id || typeof document.model !== "string") {
    throw new Error(`第三方 Provider 配置与管理标记不一致：${configPath}`);
  }
  const expectedCatalogPath = join(codexHome, definition.catalogFileName);
  const sourceCatalogPath = typeof document.model_catalog_json === "string"
    ? document.model_catalog_json
    : undefined;
  if (sourceCatalogPath === undefined || !existsSync(sourceCatalogPath)) {
    throw new Error(`第三方 Provider 模型目录缺失：${configPath}`);
  }
  assertPrivateRegularFile(expectedCatalogPath);
  const catalog = parseModelCatalog(expectedCatalogPath);
  applyLegacyRootSettings(catalog, document, definition, configPath);
  const model = modelEntry(catalog, document.model, configPath);
  const nextCatalog = `${JSON.stringify(catalog, null, 2)}\n`;
  const nextDocument = { ...document, model_catalog_json: expectedCatalogPath };
  if (mode === "switching") {
    nextDocument.model_reasoning_effort = model.default_reasoning_level;
  } else {
    delete nextDocument.model_reasoning_effort;
  }
  delete nextDocument.model_context_window;
  delete nextDocument.model_auto_compact_token_limit;
  delete nextDocument.model_auto_compact_token_limit_scope;
  const updated = [];
  if (readFileSync(expectedCatalogPath, "utf8") !== nextCatalog) {
    writePrivateFileAtomicSync(expectedCatalogPath, nextCatalog);
    updated.push(expectedCatalogPath);
  }
  const nextConfig = stringify(nextDocument);
  if (readFileSync(configPath, "utf8") !== nextConfig) {
    writePrivateFileAtomicSync(configPath, nextConfig);
    updated.push(configPath);
  }
  return updated;
}

function migrateRoleModelSettings(codexHome, rolePath) {
  assertPrivateRegularFile(rolePath);
  const document = parseManagedToml(rolePath);
  const definition = managedModelProviderDefinitions.find(
    (candidate) => candidate.id === document.model_provider,
  );
  if (!definition || typeof document.model !== "string") {
    throw new Error(`第三方子代理配置无效：${rolePath}`);
  }
  const catalogPath = join(codexHome, definition.catalogFileName);
  const catalog = parseModelCatalog(catalogPath);
  const model = modelEntry(catalog, document.model, rolePath);
  const next = {
    ...document,
    model_reasoning_effort: model.default_reasoning_level,
    model_catalog_json: catalogPath,
  };
  delete next.model_context_window;
  delete next.model_auto_compact_token_limit;
  delete next.model_auto_compact_token_limit_scope;
  const content = stringify(next);
  if (content === readFileSync(rolePath, "utf8")) return [];
  writePrivateFileAtomicSync(rolePath, content);
  return [rolePath];
}

function applyLegacyRootSettings(catalog, document, definition, configPath) {
  const model = modelEntry(catalog, document.model, configPath);
  const levels = Array.isArray(model.supported_reasoning_levels)
    ? model.supported_reasoning_levels
    : [];
  const efforts = levels.map((entry) => record(entry).effort).filter((value) =>
    typeof value === "string");
  const reasoning = document.model_reasoning_effort ?? model.default_reasoning_level;
  if (typeof reasoning !== "string" || !efforts.includes(reasoning)) {
    throw new Error(`${definition.displayName} 模型思考等级无效：${configPath}`);
  }
  const contextWindow = document.model_context_window ?? model.context_window;
  if (!Number.isSafeInteger(contextWindow) || contextWindow <= 0) {
    throw new Error(`${definition.displayName} 模型上下文窗口无效：${configPath}`);
  }
  model.context_window = contextWindow;
  const configuredLimit = document.model_auto_compact_token_limit;
  if (
    configuredLimit !== undefined
    && (!Number.isSafeInteger(configuredLimit) || configuredLimit <= 0)
  ) {
    throw new Error(`${definition.displayName} 自动压缩阈值无效：${configPath}`);
  }
  model.default_reasoning_level = reasoning;
  if (configuredLimit !== undefined) {
    model.auto_compact_token_limit = Math.min(
      configuredLimit,
      Math.floor(contextWindow * 0.9),
    );
  }
}

function parseManagedToml(path) {
  try {
    return parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`第三方 Provider 配置无法安全解析：${path}`);
  }
}

function parseModelCatalog(path) {
  let catalog;
  try {
    catalog = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`第三方 Provider 模型目录无法安全解析：${path}`);
  }
  if (!Array.isArray(catalog?.models)) {
    throw new Error(`第三方 Provider 模型目录无效：${path}`);
  }
  return catalog;
}

function modelEntry(catalog, model, sourcePath) {
  const entry = catalog.models.find((candidate) => record(candidate).slug === model);
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    throw new Error(`第三方 Provider 模型目录缺少 ${model}：${sourcePath}`);
  }
  return entry;
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
    ["codex-connect-ds-subagent.config.toml", "sf-agent.config.toml"],
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
      legacy: join(deepseekBackup, "codex-connect-ds-subagent.config.toml"),
      current: join(deepseekBackup, "sf-agent.config.toml"),
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
  legacyDsRolePath,
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
  const legacyDs = record(agents.ds);
  if (legacyDs.config_file === legacyDsRolePath) {
    if (record(agents.external).config_file === undefined) {
      agents.external = {
        ...(typeof legacyDs.description === "string"
          ? { description: legacyDs.description }
          : {}),
        ...(Array.isArray(legacyDs.nickname_candidates)
          ? { nickname_candidates: legacyDs.nickname_candidates }
          : {}),
        config_file: newRolePath,
      };
    }
    delete agents.ds;
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
