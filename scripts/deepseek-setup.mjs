import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";

import { parse, stringify } from "smol-toml";
import * as clackPrompts from "@clack/prompts";

import { codexHomePath } from "../runtime/codex-home.mjs";
import {
  deepseekProviderDefinition,
} from "../runtime/model-provider-definitions.mjs";
import {
  loadManagedModelProviderRole,
  managedProviderDirectory,
  loadManagedModelProviderSettings,
  loadPrimaryModelProvider,
  managedModelProviderRoleConfigPath,
  writeManagedModelProviderRoleConfig,
} from "../runtime/model-provider-runtime.mjs";
import {
  readPrivateFileSync,
  writePrivateFileAtomic,
} from "../runtime/private-file.mjs";
import {
  createManagedProviderMarker,
} from "../runtime/model-provider-profile.mjs";
import {
  assertThirdPartyRoleAvailable,
  configureThirdPartyRole,
} from "./agents.mjs";
import { runModelProviderDefaultSetup } from "./model-provider-default-setup.mjs";
import {
  ManagedModelProviderSetupError,
  applyExclusiveProviderConfig,
  createManagedProviderCatalog,
  createManagedProviderRestorePreview,
  createSwitchingProviderProfile,
  hasProviderBaseConfig,
  restoreProviderBaseConfig,
} from "./managed-model-provider-setup.mjs";

export const deepseekSetupScriptUrl =
  "https://cdn.deepseek.com/api-docs/codex-deepseek-setup.sh";
const providerId = deepseekProviderDefinition.id;
const supportedModel = deepseekProviderDefinition.defaultModel;
const maximumScriptBytes = 2 * 1024 * 1024;
const defaultDownloadAttempts = 3;
const defaultDownloadTimeoutMs = 30_000;
const defaultAutoCompactPercent = 60;
const minimumAutoCompactPercent = 10;
const maximumAutoCompactPercent = 90;
const previousDefaultModel = "deepseek-v4-flash";

class DeepseekSetupCancelled extends Error {}

export function previewDeepseekConfiguration(
  { mode = "switching" },
  { environment = process.env } = {},
) {
  if (mode !== "switching" && mode !== "exclusive") {
    throw managedSetupInvalid(
      "invalid-mode",
      "mode",
      "DeepSeek 模式必须是 switching 或 exclusive",
    );
  }
  try {
    assertThirdPartyRoleAvailable(environment);
  } catch (error) {
    throw managedSetupInvalid(
      "provider-conflict",
      "provider",
      error instanceof Error ? error.message : String(error),
      error,
    );
  }
  if (mode === "exclusive") {
    let primary;
    try {
      primary = loadPrimaryModelProvider(environment);
    } catch (error) {
      throw managedSetupInvalid(
        "provider-state-unavailable",
        "provider",
        error instanceof Error ? error.message : String(error),
        error,
      );
    }
    if (primary !== "openai" && primary !== providerId) {
      throw managedSetupInvalid(
        "provider-conflict",
        "provider",
        `请先恢复当前固定 Provider：${primary}`,
      );
    }
  }
  const configured = existsSync(deepseekSetupPaths(environment).backupStatePath);
  return {
    operation: configured ? "reconfigure" : "add",
    provider: { id: providerId, name: deepseekProviderDefinition.displayName },
    mode,
    effects: {
      writesMainConfig: mode === "exclusive",
      writesIsolatedProfile: mode === "switching",
      downloadsCatalog: true,
      updatesExternalAgent: true,
      preservesInitialConfig: true,
    },
    confirmation: {
      required: mode === "exclusive",
      field: "confirmExclusiveConfigChange",
    },
    activation: "restart-all",
  };
}

export async function applyDeepseekConfiguration(
  {
    mode = "switching",
    apiKey,
    autoCompactPercent,
    confirmExclusiveConfigChange = false,
  },
  {
    environment = process.env,
    fetchImpl = globalThis.fetch,
    downloadCatalog = downloadDeepseekCatalog,
    configureRole = configureThirdPartyRole,
  } = {},
) {
  const preview = previewDeepseekConfiguration({ mode }, { environment });
  if (mode === "exclusive" && confirmExclusiveConfigChange !== true) {
    throw managedSetupInvalid(
      "confirmation-required",
      "confirmExclusiveConfigChange",
      "固定模式会修改并备份 Codex 主配置，必须先明确确认",
    );
  }
  if (
    typeof apiKey !== "string"
    || !/^sk-[^\s"]+$/u.test(apiKey)
    || apiKey.length > 4_096
  ) {
    throw managedSetupInvalid("invalid-api-key", "apiKey", "DeepSeek API Key 无效");
  }
  if (
    autoCompactPercent !== undefined
    && (!Number.isInteger(autoCompactPercent)
      || autoCompactPercent < minimumAutoCompactPercent
      || autoCompactPercent > maximumAutoCompactPercent)
  ) {
    throw managedSetupInvalid(
      "invalid-auto-compact-percent",
      "autoCompactPercent",
      "DeepSeek 自动压缩百分比无效",
    );
  }

  let downloaded;
  try {
    downloaded = await downloadCatalog(fetchImpl);
  } catch (error) {
    throw managedSetupInvalid(
      "catalog-unavailable",
      "catalog",
      error instanceof Error ? error.message : String(error),
      error,
    );
  }
  try {
    return await configureDeepseekInstallation({
      mode,
      apiKey,
      autoCompactPercent,
      downloaded,
      environment,
      configureRole,
      preview,
    });
  } catch (error) {
    if (error instanceof ManagedModelProviderSetupError) throw error;
    throw managedSetupInvalid(
      "operation-failed",
      "action",
      error instanceof Error ? error.message : String(error),
      error,
    );
  }
}

export async function previewDeepseekRestore({
  environment = process.env,
} = {}) {
  const paths = deepseekSetupPaths(environment);
  await readDeepseekRestoreState(paths.backupStatePath);
  return createManagedProviderRestorePreview(deepseekProviderDefinition);
}

export async function applyDeepseekRestore(
  { confirmRestore = false },
  { environment = process.env } = {},
) {
  const preview = await previewDeepseekRestore({ environment });
  if (confirmRestore !== true) {
    throw managedSetupInvalid(
      "confirmation-required",
      "confirmRestore",
      "恢复 DeepSeek 初始配置前必须明确确认",
    );
  }
  const paths = deepseekSetupPaths(environment);
  try {
    await restoreInitialConfig(paths);
  } catch (error) {
    if (error instanceof ManagedModelProviderSetupError) throw error;
    throw managedSetupInvalid(
      "operation-failed",
      "restore",
      error instanceof Error ? error.message : String(error),
      error,
    );
  }
  return { action: "restored", ...preview };
}

export async function runDeepseekSetup({
  allowBack = false,
  environment = process.env,
  output = process.stdout,
  fetchImpl = globalThis.fetch,
  prompter,
  prompts = clackPrompts,
  configureRole = configureThirdPartyRole,
} = {}) {
  const prompt = prompter ?? createHiddenPrompter(prompts, { allowBack });
  try {
    output.write("\nCodex Connect DeepSeek Setup\n\n");
    output.write("1. OpenAI + DeepSeek 切换模式（保留 OpenAI 默认）\n");
    output.write("2. 仅 DeepSeek 固定模式（原生 Codex 也默认使用 DeepSeek）\n");
    output.write("3. 恢复安装前的 Codex 配置\n");
    output.write("4. 修改模型设置（思考等级、自动压缩）\n");
    if (allowBack) output.write("5. 返回上一级\n");
    const choice = await askChoice(
      prompt,
      allowBack ? "请选择 [1-5]" : "请选择 [1-4]",
      allowBack ? 5 : 4,
    );
    if (choice === "5") return { action: "back" };
    if (choice === "4") {
      return runModelProviderDefaultSetup({
        allowBack: true,
        provider: providerId,
        environment,
        output,
        prompts,
      });
    }
    const paths = deepseekSetupPaths(environment);
    const {
      configPath,
      profilePath,
      catalogPath,
    } = paths;
    if (choice === "3") {
      await previewDeepseekRestore({ environment });
      output.write("恢复会覆盖 DeepSeek 安装后对 ~/.codex/config.toml 做的其他修改。\n");
      if (!await prompt.confirm("确认恢复首次安装前的配置？", false)) {
        output.write("已取消，未修改任何文件。\n");
        return undefined;
      }
      await applyDeepseekRestore({ confirmRestore: true }, { environment });
      output.write("已恢复安装前的 Codex 配置；备份目录保留以便审计。\n");
      output.write("请重启 Gateway 与 App Server：codexc service restart all\n");
      return deepseekRestoreResult(paths);
    }
    const mode = choice === "1" ? "switching" : "exclusive";
    previewDeepseekConfiguration({ mode }, { environment });
    if (mode === "switching") {
      output.write(
        "\n切换模式保留 OpenAI 默认；DeepSeek 模型、Provider 与 API Key 全部保存在独立 Profile。\n",
      );
    }
    if (mode === "exclusive") {
      output.write("\n固定模式会修改 ~/.codex/config.toml，并将 DeepSeek API Key 写入该 0600 文件。\n");
      if (!await prompt.confirm("确认继续并先备份原配置？", false)) {
        output.write("已取消，未修改任何文件。\n");
        return undefined;
      }
    }
    const apiKey = await askApiKey(prompt);
    const autoCompactPercent = await askAutoCompact(prompt);
    await applyDeepseekConfiguration({
      mode,
      apiKey,
      autoCompactPercent,
      confirmExclusiveConfigChange: mode === "exclusive",
    }, {
      environment,
      fetchImpl,
      configureRole,
    });
    if (mode === "switching") {
      output.write(`\nOpenAI 默认模型与认证保持不变：${configPath}\n`);
      output.write(`DeepSeek CLI Profile 已保存：${profilePath}\n`);
      output.write("已将共享第三方子代理（agents.external）切换到 DeepSeek。\n");
    } else {
      output.write(`\nDeepSeek 固定配置已保存：${configPath}\n`);
      output.write("已将共享第三方子代理（agents.external）切换到 DeepSeek。\n");
    }
    output.write(`模型目录已从官方脚本下载：${catalogPath}\n`);
    output.write(mode === "switching"
      ? `原生 Codex 使用 OpenAI：codex；使用 DeepSeek：codex --profile ${deepseekProviderDefinition.codexProfileName}\n共享 TUI：codexc remote；DeepSeek 共享 TUI：codexc remote --profile ${deepseekProviderDefinition.profileName}\n`
      : `原生 Codex 和 Gateway 将默认使用 ${supportedModel}。\n`);
    output.write("请重启 Gateway 与 App Server：codexc service restart all\n");
    return deepseekSetupResult(paths, mode);
  } catch (error) {
    if (allowBack && error instanceof DeepseekSetupCancelled) {
      return { action: "back" };
    }
    throw error;
  } finally {
    prompt.close();
  }
}

async function configureDeepseekInstallation({
  mode,
  apiKey,
  autoCompactPercent,
  downloaded,
  environment,
  configureRole,
  preview,
}) {
  const paths = deepseekSetupPaths(environment);
  const {
    codexHome,
    configPath,
    roleConfigPath,
    profilePath,
    gatewayProfilePath,
    catalogPath,
    manifestPath,
    backupPath,
    profileBackupPath,
    gatewayProfileBackupPath,
    roleConfigBackupPath,
    backupStatePath,
  } = paths;
  const previousManifest = await readOptionalJson(
    manifestPath,
    "DeepSeek 模型目录清单",
  );
  const defaultModelMigration = readDefaultModelMigration(previousManifest);
  const installationPaths = [
    configPath,
    profilePath,
    gatewayProfilePath,
    catalogPath,
    manifestPath,
    roleConfigPath,
    backupPath,
    profileBackupPath,
    gatewayProfileBackupPath,
    roleConfigBackupPath,
    backupStatePath,
  ];
  const installationSnapshots = await snapshotFiles(installationPaths);
  let rollbackGuards = installationSnapshots;
  try {
    await mkdir(codexHome, { recursive: true, mode: 0o700 });
    await preserveInitialConfig({
      configPath,
      profilePath,
      gatewayProfilePath,
      backupPath,
      profileBackupPath,
      gatewayProfileBackupPath,
      roleConfigPath,
      roleConfigBackupPath,
      backupStatePath,
    });
    rollbackGuards = await snapshotFiles(installationPaths);
    const previous = await loadPreviousManagedSettings({
      environment,
      gatewayProfilePath,
      gatewayProfileBackupPath,
      backupStatePath,
    });
    const selectedModel = previous?.model ?? supportedModel;
    const managedCatalog = createManagedDeepseekCatalog(
      downloaded.catalog,
      previous?.models,
      autoCompactPercent ?? null,
    );
    const selectedModelEntry = managedCatalog.models?.find(
      (entry) => entry?.slug === selectedModel,
    );
    const selectedModelReasoningEffort = selectedModelEntry?.default_reasoning_level;
    if (typeof selectedModelReasoningEffort !== "string") {
      throw new Error("DeepSeek 模型目录缺少默认思考等级，未修改配置");
    }
    const { configContent, profileContent, gatewayProfileContent } = await buildCodexConfig({
      configPath,
      gatewayProfilePath,
      gatewayProfileBackupPath,
      backupPath,
      backupStatePath,
      catalogPath,
      apiKey,
      mode,
      model: selectedModel,
      reasoningEffort: selectedModelReasoningEffort,
    });
    await writePrivateFileAtomic(
      catalogPath,
      `${JSON.stringify(managedCatalog, null, 2)}\n`,
    );
    rollbackGuards = await snapshotFiles(installationPaths);
    await writePrivateFileAtomic(manifestPath, `${JSON.stringify({
      source: deepseekSetupScriptUrl,
      sha256: downloaded.sha256,
      downloadedAt: new Date().toISOString(),
      ...(defaultModelMigration === undefined
        ? {}
        : { defaultModelMigration }),
    }, null, 2)}\n`);
    rollbackGuards = await snapshotFiles(installationPaths);
    await replaceOptionalFile(configPath, configContent);
    rollbackGuards = await snapshotFiles(installationPaths);
    await replaceOptionalFile(profilePath, profileContent);
    rollbackGuards = await snapshotFiles(installationPaths);
    await replaceOptionalFile(gatewayProfilePath, gatewayProfileContent);
    rollbackGuards = await snapshotFiles(installationPaths);
    await setBackupRestoredState(backupStatePath, false);
    rollbackGuards = await snapshotFiles(installationPaths);
    await configureRole(providerId, selectedModel, environment);
    return {
      action: "configured",
      model: selectedModel,
      paths: deepseekPublicPaths(paths),
      ...preview,
    };
  } catch (error) {
    try {
      await restoreFileSnapshots(installationSnapshots, rollbackGuards);
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        "DeepSeek 配置失败，且未能完整恢复操作前文件",
        { cause: rollbackError },
      );
    }
    throw error;
  }
}

export async function downloadDeepseekCatalog(
  fetchImpl,
  {
    attempts = defaultDownloadAttempts,
    sleep = defaultSleep,
    timeoutMs = defaultDownloadTimeoutMs,
  } = {},
) {
  if (typeof fetchImpl !== "function") {
    throw new Error("当前 Node.js 环境不支持 fetch");
  }
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const signal = globalThis.AbortSignal.timeout(timeoutMs);
    let response;
    try {
      response = await fetchImpl(deepseekSetupScriptUrl, {
        headers: { accept: "text/plain" },
        redirect: "follow",
        signal,
      });
    } catch {
      lastError = signal.aborted
        ? new Error("DeepSeek 官方脚本下载超时")
        : new Error("DeepSeek 官方脚本网络请求失败");
      if (attempt < attempts) {
        await sleep(attempt * 1_000);
        continue;
      }
      throw lastError;
    }
    if (!response.ok) {
      lastError = new Error(`DeepSeek 官方脚本下载失败：HTTP ${response.status}`);
      if (!isRetryableStatus(response.status) || attempt === attempts) throw lastError;
      await sleep(attempt * 1_000);
      continue;
    }
    if (response.url && response.url !== deepseekSetupScriptUrl) {
      throw new Error("DeepSeek 官方脚本下载发生了未允许的重定向");
    }
    let script;
    try {
      script = await readLimitedResponseText(response, maximumScriptBytes);
    } catch (error) {
      if (error instanceof Error && error.message === "DeepSeek 官方脚本超过允许大小") {
        throw error;
      }
      lastError = signal.aborted
        ? new Error("DeepSeek 官方脚本下载超时")
        : new Error("DeepSeek 官方脚本响应读取失败");
      if (attempt < attempts) {
        await sleep(attempt * 1_000);
        continue;
      }
      throw lastError;
    }
    const catalog = extractDeepseekCatalog(script);
    return {
      catalog,
      sha256: createHash("sha256").update(script).digest("hex"),
    };
  }
  throw lastError ?? new Error("DeepSeek 官方脚本下载失败");
}

async function readLimitedResponseText(response, maximumBytes) {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && Number(contentLength) > maximumBytes) {
    throw new Error("DeepSeek 官方脚本超过允许大小");
  }
  if (!response.body) {
    throw new Error("DeepSeek 官方脚本响应缺少正文");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maximumBytes) {
      await reader.cancel();
      throw new Error("DeepSeek 官方脚本超过允许大小");
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

function isRetryableStatus(status) {
  return status === 429 || (status >= 500 && status <= 599);
}

function defaultSleep(milliseconds) {
  return new Promise((resolveSleep) => {
    setTimeout(resolveSleep, milliseconds);
  });
}

export function extractDeepseekCatalog(script) {
  const matches = [...script.matchAll(
    /<<'CODEX_MODELS_JSON'\s*\r?\n([\s\S]*?)\r?\nCODEX_MODELS_JSON(?:\r?\n|$)/gu,
  )];
  if (matches.length !== 1) {
    throw new Error("DeepSeek 官方脚本中的模型目录标记无效");
  }
  let catalog;
  try {
    catalog = JSON.parse(matches[0][1]);
  } catch {
    throw new Error("DeepSeek 官方模型目录不是有效 JSON");
  }
  if (!catalog || !Array.isArray(catalog.models)) {
    throw new Error("DeepSeek 官方模型目录缺少 models");
  }
  const defaultModel = catalog.models.find((model) => model?.slug === supportedModel);
  if (!defaultModel || typeof defaultModel !== "object") {
    throw new Error(`DeepSeek 官方模型目录缺少 ${supportedModel}`);
  }
  return catalog;
}

export function createManagedDeepseekCatalog(
  catalog,
  previousModels = [],
  autoCompactPercent = defaultAutoCompactPercent,
) {
  if (autoCompactPercent !== null && (
    !Number.isInteger(autoCompactPercent)
    || autoCompactPercent < minimumAutoCompactPercent
    || autoCompactPercent > maximumAutoCompactPercent
  )) {
    throw new Error("DeepSeek 自动压缩百分比无效");
  }
  return createManagedProviderCatalog(
    catalog,
    deepseekProviderDefinition,
    {
      previousModels,
      autoCompactPercent,
    },
  );
}

export async function refreshDeepseekCatalogForUpdate(
  environment = process.env,
  options = {},
) {
  const previous = loadManagedModelProviderSettings(environment).find(
    (candidate) => candidate.provider === providerId,
  );
  if (!previous) return { status: "not-configured" };
  const downloaded = await (options.downloadCatalog
    ? options.downloadCatalog()
    : downloadDeepseekCatalog(options.fetchImpl ?? globalThis.fetch));
  const managedCatalog = createManagedDeepseekCatalog(
    downloaded.catalog,
    previous.models,
  );
  const providerDirectory = managedProviderDirectory(
    environment,
    deepseekProviderDefinition,
  );
  const catalogPath = join(providerDirectory, deepseekProviderDefinition.catalogFileName);
  const manifestPath = join(
    providerDirectory,
    deepseekProviderDefinition.catalogManifestFileName,
  );
  const previousManifest = await readOptionalJson(
    manifestPath,
    "DeepSeek 模型目录清单",
  );
  const previousMigration = readDefaultModelMigration(previousManifest);
  const migrationAlreadyApplied = previousMigration !== undefined;
  const modelMigrated = !migrationAlreadyApplied
    && previous.model === previousDefaultModel;
  const selectedModel = modelMigrated ? supportedModel : previous.model;
  const selectedModelEntry = managedCatalog.models.find(
    (model) => model?.slug === selectedModel,
  );
  const reasoningEffort = selectedModelEntry?.default_reasoning_level;
  if (typeof reasoningEffort !== "string") {
    throw new Error("DeepSeek 模型目录缺少默认思考等级");
  }
  const documentPath = previous.mode === "switching"
    ? join(codexHomePath(environment), deepseekProviderDefinition.profileFileName)
    : join(codexHomePath(environment), "config.toml");
  let documentUpdate;
  if (modelMigrated) {
    const document = readPrivateToml(documentPath, "DeepSeek 默认模型配置");
    if (
      document.model !== previousDefaultModel
      || document.model_provider !== providerId
    ) {
      throw new Error("DeepSeek 默认模型配置不一致");
    }
    document.model = supportedModel;
    if (previous.mode === "switching") {
      document.model_reasoning_effort = reasoningEffort;
    } else {
      delete document.model_reasoning_effort;
      delete document.model_context_window;
      delete document.model_auto_compact_token_limit;
      delete document.model_auto_compact_token_limit_scope;
    }
    documentUpdate = stringify(document);
  }
  const role = loadManagedModelProviderRole(environment);
  const roleMigrated = !migrationAlreadyApplied
    && role?.provider === providerId
    && role.model === previousDefaultModel;
  const roleConfigPath = managedModelProviderRoleConfigPath(environment);
  const paths = [
    catalogPath,
    manifestPath,
    ...(documentUpdate === undefined ? [] : [documentPath]),
    ...(roleMigrated ? [roleConfigPath] : []),
  ];
  const snapshots = await snapshotFiles(paths);
  let guards = snapshots;
  try {
    await writePrivateFileAtomic(
      catalogPath,
      `${JSON.stringify(managedCatalog, null, 2)}\n`,
    );
    guards = await snapshotFiles(paths);
    const updatedAt = (options.now ?? (() => new Date()))().toISOString();
    await writePrivateFileAtomic(manifestPath, `${JSON.stringify({
      source: deepseekSetupScriptUrl,
      sha256: downloaded.sha256,
      downloadedAt: updatedAt,
      defaultModelMigration: migrationAlreadyApplied
        ? previousMigration
        : {
            from: previousDefaultModel,
            to: supportedModel,
            appliedAt: updatedAt,
          },
    }, null, 2)}\n`);
    guards = await snapshotFiles(paths);
    if (documentUpdate !== undefined) {
      await writePrivateFileAtomic(documentPath, documentUpdate);
      guards = await snapshotFiles(paths);
    }
    if (roleMigrated) {
      writeManagedModelProviderRoleConfig(environment, {
        provider: role.provider,
        model: supportedModel,
      });
      guards = await snapshotFiles(paths);
    }
  } catch (error) {
    try {
      await restoreFileSnapshots(snapshots, guards);
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        "DeepSeek 模型目录更新失败，且未能完整恢复更新前文件",
        { cause: rollbackError },
      );
    }
    throw error;
  }
  return {
    status: "updated",
    catalogPath,
    manifestPath,
    modelCount: managedCatalog.models.length,
    selectedModel,
    modelMigrated,
    roleMigrated,
    defaultModelMigrationApplied: !migrationAlreadyApplied,
  };
}

function readDefaultModelMigration(manifest) {
  const migration = manifest?.defaultModelMigration;
  if (migration === undefined) return undefined;
  if (!migration
    || typeof migration !== "object"
    || Array.isArray(migration)
    || migration.from !== previousDefaultModel
    || migration.to !== supportedModel
    || typeof migration.appliedAt !== "string"
    || !Number.isFinite(Date.parse(migration.appliedAt))) {
    throw new Error("DeepSeek 默认模型迁移标记无效");
  }
  return migration;
}

async function readOptionalJson(path, label) {
  let content;
  try {
    content = readPrivateFileSync(path);
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
  try {
    const value = JSON.parse(content);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    throw new Error(`${label}无法安全读取或解析`);
  }
}

function readPrivateToml(path, label) {
  try {
    return parse(readPrivateFileSync(path));
  } catch {
    throw new Error(`${label}无法安全读取或解析`);
  }
}

async function buildCodexConfig({
  configPath,
  gatewayProfilePath,
  gatewayProfileBackupPath,
  backupPath,
  backupStatePath,
  catalogPath,
  apiKey,
  mode,
  model,
  reasoningEffort,
}) {
  let initialDocument = {};
  let originalContent;
  let backupState;
  try {
    backupState = JSON.parse(await readFile(backupStatePath, "utf8"));
    if (backupState.originalConfigExisted === true) {
      originalContent = await readFile(backupPath, "utf8");
      initialDocument = parse(originalContent);
    } else if (backupState.originalConfigExisted !== false) {
      throw new Error("invalid backup state");
    }
  } catch (error) {
    if (error.code !== "ENOENT") {
      // TOML 解析错误可能包含带 API Key 的原始配置行，不能作为 cause 暴露。
      // eslint-disable-next-line preserve-caught-error
      throw new Error("现有 Codex config.toml 无法读取或解析，未修改配置");
    }
  }
  const current = await readCurrentConfig(configPath);
  let document = current.document;
  let configContent = current.content;
  const managedMode = await readCurrentManagedMode(
    gatewayProfilePath,
    backupState?.originalGatewayProfileExisted === true
      ? gatewayProfileBackupPath
      : undefined,
  );
  const legacyManagedLayout = managedMode === undefined
    && backupState !== undefined
    && backupState.restored !== true
    && hasProviderBaseConfig(document, deepseekProviderDefinition);
  const profile = createSwitchingProviderProfile(deepseekProviderDefinition, {
    apiKey,
    catalogPath,
    model,
    reasoningEffort,
  });
  if (mode === "switching") {
    if (managedMode === "exclusive" || legacyManagedLayout) {
      document = restoreProviderBaseConfig(document, initialDocument, deepseekProviderDefinition);
      configContent = Object.keys(document).length === 0 ? undefined : stringify(document);
    }
    if (
      document.profile === providerId
      || table(document.profiles)[providerId] !== undefined
    ) {
      throw new Error(
        "安装前的 Codex config.toml 已占用旧式 deepseek profile；请先手工迁移或改名",
      );
    }
    if (table(document.model_providers)[providerId] !== undefined) {
      throw new Error(
        "安装前的 Codex config.toml 已存在 deepseek Provider；请先手工移除或改名",
      );
    }
    return {
      configContent,
      profileContent: stringify(profile),
      gatewayProfileContent: stringify(
        createManagedProviderMarker(deepseekProviderDefinition, "switching"),
      ),
    };
  }

  document = applyExclusiveProviderConfig(document, deepseekProviderDefinition, {
    apiKey,
    catalogPath,
    model,
  });
  return {
    configContent: stringify(document),
    profileContent: undefined,
    gatewayProfileContent: stringify(
      createManagedProviderMarker(deepseekProviderDefinition, "exclusive"),
    ),
  };
}

async function readCurrentConfig(configPath) {
  try {
    const content = await readFile(configPath, "utf8");
    return { content, document: parse(content) };
  } catch (error) {
    if (error.code === "ENOENT") return { content: undefined, document: {} };
    // TOML 解析错误可能包含带 API Key 的原始配置行，不能作为 cause 暴露。
    // eslint-disable-next-line preserve-caught-error
    throw new Error("现有 Codex config.toml 无法读取或解析，未修改配置");
  }
}

async function readCurrentManagedMode(gatewayProfilePath, originalGatewayProfilePath) {
  try {
    const content = await readFile(gatewayProfilePath, "utf8");
    if (
      originalGatewayProfilePath !== undefined
      && content === await readFile(originalGatewayProfilePath, "utf8")
    ) {
      return undefined;
    }
    const marker = parse(content);
    if (
      marker.version !== 1
      || marker.provider !== providerId
      || ![undefined, "switching", "exclusive"].includes(marker.mode)
    ) {
      throw new Error("invalid marker");
    }
    return marker.mode ?? "switching";
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    // 原同名文件可能包含用户私有配置，不能把解析内容作为 cause 暴露。
    // eslint-disable-next-line preserve-caught-error
    throw new Error("Codex Connect DeepSeek 管理标记无效，未修改配置");
  }
}

async function loadPreviousManagedSettings({
  environment,
  gatewayProfilePath,
  gatewayProfileBackupPath,
  backupStatePath,
}) {
  const state = JSON.parse(await readFile(backupStatePath, "utf8"));
  const mode = await readCurrentManagedMode(
    gatewayProfilePath,
    state.originalGatewayProfileExisted === true ? gatewayProfileBackupPath : undefined,
  );
  if (mode === undefined) return undefined;
  return loadManagedModelProviderSettings(environment).find(
    (candidate) => candidate.provider === providerId,
  );
}

async function preserveInitialConfig({
  configPath,
  profilePath,
  gatewayProfilePath,
  backupPath,
  profileBackupPath,
  gatewayProfileBackupPath,
  roleConfigPath,
  roleConfigBackupPath,
  backupStatePath,
}) {
  let state;
  try {
    state = JSON.parse(await readFile(backupStatePath, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const initialStateMissing = state === undefined;
  if (initialStateMissing) {
    state = {};
    state.originalConfigExisted = await backupIfPresent(configPath, backupPath);
  } else if (typeof state.originalConfigExisted !== "boolean") {
    throw new Error("Codex 初始配置备份状态无效");
  }
  if (typeof state.originalProfileExisted !== "boolean") {
    state.originalProfileExisted = await backupIfPresent(profilePath, profileBackupPath);
  }
  if (typeof state.originalGatewayProfileExisted !== "boolean") {
    state.originalGatewayProfileExisted = await backupIfPresent(
      gatewayProfilePath,
      gatewayProfileBackupPath,
    );
  }
  if (state.originalRoleConfigExisted === undefined) {
    state.originalRoleConfigExisted = initialStateMissing
      ? await backupIfPresent(roleConfigPath, roleConfigBackupPath)
      : false;
  } else if (typeof state.originalRoleConfigExisted !== "boolean") {
    throw new Error("Codex 初始配置备份状态无效");
  }
  await writePrivateFileAtomic(backupStatePath, `${JSON.stringify(state)}\n`);
}

async function setBackupRestoredState(backupStatePath, restored) {
  let state;
  try {
    state = JSON.parse(await readFile(backupStatePath, "utf8"));
  } catch {
    throw new Error("Codex 初始配置备份状态无效");
  }
  if (typeof state.originalConfigExisted !== "boolean") {
    throw new Error("Codex 初始配置备份状态无效");
  }
  state.restored = restored;
  await writePrivateFileAtomic(backupStatePath, `${JSON.stringify(state)}\n`);
}

async function backupIfPresent(sourcePath, backupPath) {
  try {
    await writePrivateFileAtomic(backupPath, await readFile(sourcePath));
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function restoreInitialConfig({
  configPath,
  profilePath,
  gatewayProfilePath,
  catalogPath,
  manifestPath,
  roleConfigPath,
  backupPath,
  profileBackupPath,
  gatewayProfileBackupPath,
  roleConfigBackupPath,
  backupStatePath,
}) {
  const state = await readDeepseekRestoreState(backupStatePath);
  if (state.originalConfigExisted === true) {
    await writePrivateFileAtomic(configPath, await readFile(backupPath));
  } else if (state.originalConfigExisted === false) {
    await removeFile(configPath);
  } else {
    throw new Error("Codex 初始配置备份状态无效");
  }
  if (state.originalProfileExisted === true) {
    await writePrivateFileAtomic(profilePath, await readFile(profileBackupPath));
  } else if (state.originalProfileExisted === false) {
    await removeFile(profilePath);
  }
  if (state.originalGatewayProfileExisted === true) {
    await writePrivateFileAtomic(gatewayProfilePath, await readFile(gatewayProfileBackupPath));
  } else if (state.originalGatewayProfileExisted === false) {
    await removeFile(gatewayProfilePath);
  }
  await removeFile(catalogPath);
  await removeFile(manifestPath);
  if (state.originalRoleConfigExisted === true) {
    await writePrivateFileAtomic(roleConfigPath, await readFile(roleConfigBackupPath));
  } else if (
    state.originalRoleConfigExisted === false
    || state.originalRoleConfigExisted === undefined
  ) {
    await removeFile(roleConfigPath);
  } else {
    throw new Error("Codex 初始配置备份状态无效");
  }
  await setBackupRestoredState(backupStatePath, true);
}

async function readDeepseekRestoreState(backupStatePath) {
  let state;
  try {
    state = JSON.parse(await readFile(backupStatePath, "utf8"));
  } catch (error) {
    throw managedSetupInvalid(
      error?.code === "ENOENT" ? "backup-not-found" : "backup-invalid",
      "restore",
      error?.code === "ENOENT"
        ? "未找到可恢复的 Codex 初始配置"
        : "Codex 初始配置备份状态无效",
    );
  }
  if (
    typeof state?.originalConfigExisted !== "boolean"
    || (state.originalProfileExisted !== undefined
      && typeof state.originalProfileExisted !== "boolean")
    || (state.originalGatewayProfileExisted !== undefined
      && typeof state.originalGatewayProfileExisted !== "boolean")
    || (state.originalRoleConfigExisted !== undefined
      && typeof state.originalRoleConfigExisted !== "boolean")
  ) {
    throw managedSetupInvalid(
      "backup-invalid",
      "restore",
      "Codex 初始配置备份状态无效",
    );
  }
  return state;
}

function deepseekSetupPaths(environment) {
  const codexHome = codexHomePath(environment);
  const providerDirectory = managedProviderDirectory(
    environment,
    deepseekProviderDefinition,
  );
  const backupDirectory = join(
    providerDirectory,
    deepseekProviderDefinition.backupDirectoryName,
  );
  return {
    codexHome,
    configPath: join(codexHome, "config.toml"),
    roleConfigPath: managedModelProviderRoleConfigPath(environment),
    profilePath: join(codexHome, deepseekProviderDefinition.profileFileName),
    gatewayProfilePath: join(
      providerDirectory,
      deepseekProviderDefinition.managedMarkerFileName,
    ),
    catalogPath: join(providerDirectory, deepseekProviderDefinition.catalogFileName),
    manifestPath: join(
      providerDirectory,
      deepseekProviderDefinition.catalogManifestFileName,
    ),
    backupPath: join(backupDirectory, "config.toml"),
    profileBackupPath: join(
      backupDirectory,
      deepseekProviderDefinition.profileFileName,
    ),
    gatewayProfileBackupPath: join(
      backupDirectory,
      deepseekProviderDefinition.managedMarkerFileName,
    ),
    roleConfigBackupPath: join(backupDirectory, "sf-agent.config.toml"),
    backupStatePath: join(backupDirectory, "state.json"),
  };
}

function deepseekRestoreResult(paths) {
  return deepseekSetupResult(paths, "restored");
}

function deepseekSetupResult(paths, mode) {
  return {
    mode,
    configPath: paths.configPath,
    profilePath: paths.profilePath,
    gatewayProfilePath: paths.gatewayProfilePath,
    catalogPath: paths.catalogPath,
    backupPath: paths.backupPath,
  };
}

function deepseekPublicPaths(paths) {
  return {
    configPath: paths.configPath,
    profilePath: paths.profilePath,
    markerPath: paths.gatewayProfilePath,
    catalogPath: paths.catalogPath,
  };
}

function managedSetupInvalid(code, field, message, cause) {
  return new ManagedModelProviderSetupError(
    code,
    field,
    message,
    cause === undefined ? undefined : { cause },
  );
}

async function replaceOptionalFile(path, content) {
  if (content === undefined) {
    await removeFile(path);
    return;
  }
  try {
    if (await readFile(path, "utf8") === content) return;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await writePrivateFileAtomic(path, content);
}

async function removeFile(path) {
  try {
    await unlink(path);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

async function snapshotFiles(paths) {
  const snapshots = new Map();
  for (const path of paths) {
    try {
      snapshots.set(path, await readFile(path));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      snapshots.set(path, undefined);
    }
  }
  return snapshots;
}

async function restoreFileSnapshots(snapshots, guards) {
  for (const [path, expected] of guards) {
    const current = await readOptionalFile(path);
    if (!sameOptionalContent(current, expected)) {
      throw new Error(`DeepSeek 配置文件在事务期间发生变化：${path}`);
    }
  }
  for (const [path, content] of snapshots) {
    if (content === undefined) {
      await removeFile(path);
    } else {
      await writePrivateFileAtomic(path, content);
    }
  }
}

async function readOptionalFile(path) {
  try {
    return await readFile(path);
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
}

function sameOptionalContent(left, right) {
  if (left === undefined || right === undefined) return left === right;
  return left.equals(right);
}

async function askChoice(prompt, label, maximum) {
  while (true) {
    const choice = await prompt.ask(label);
    if (new RegExp(`^[1-${maximum}]$`, "u").test(choice)) return choice;
  }
}

async function askApiKey(prompt) {
  while (true) {
    const apiKey = await prompt.secret("DeepSeek API Key（以 sk- 开头）");
    if (/^sk-[^\s"]+$/u.test(apiKey) && apiKey.length <= 4_096) return apiKey;
  }
}

async function askAutoCompact(prompt) {
  const choice = await askChoice(
    prompt,
    "自动压缩阈值：1 模型默认（90%） · 2 60% · 3 自定义",
    3,
  );
  if (choice === "1") return undefined;
  if (choice === "2") return defaultAutoCompactPercent;
  while (true) {
    const value = await prompt.text(
      `自定义自动压缩百分比 [${minimumAutoCompactPercent}-${maximumAutoCompactPercent}]`,
    );
    if (!/^\d+$/u.test(value)) continue;
    const parsed = Number(value);
    if (
      Number.isInteger(parsed)
      && parsed >= minimumAutoCompactPercent
      && parsed <= maximumAutoCompactPercent
    ) {
      return parsed;
    }
  }
}

function table(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function createHiddenPrompter(prompts, { allowBack }) {
  const autoCompactOptions = [
    { value: "1", label: "使用模型默认（90%）" },
    { value: "2", label: `按 ${defaultAutoCompactPercent}% 上下文窗口压缩` },
    { value: "3", label: "自定义百分比" },
  ];
  const installOptions = [
    { value: "1", label: "OpenAI + DeepSeek 切换模式" },
    { value: "2", label: "仅 DeepSeek 固定模式" },
    { value: "3", label: "恢复安装前配置" },
    { value: "4", label: "修改模型设置（思考等级、自动压缩）" },
    ...(allowBack ? [{ value: "5", label: "返回上一级" }] : []),
  ];
  return {
    ask: async (label) => {
      const autoCompact = typeof label === "string" && label.startsWith("自动压缩");
      const value = await prompts.select({
        message: autoCompact ? "设置自动压缩阈值" : "选择 DeepSeek 安装模式",
        options: autoCompact ? autoCompactOptions : installOptions,
      });
      return requirePromptValue(prompts, value);
    },
    text: async (label) => requirePromptValue(
      prompts,
      await prompts.text({ message: label }),
    ),
    secret: async (label) => requirePromptValue(
      prompts,
      await prompts.password({ message: label }),
    ),
    confirm: async (label, initialValue) => requirePromptValue(
      prompts,
      await prompts.confirm({ message: label, initialValue }),
    ),
    close: () => undefined,
  };
}

function requirePromptValue(prompts, value) {
  if (prompts.isCancel(value)) {
    throw new DeepseekSetupCancelled("DeepSeek Setup 已取消");
  }
  return value;
}
