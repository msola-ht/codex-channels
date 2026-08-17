import { createHash } from "node:crypto";
import { mkdir, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";

import { parse, stringify } from "smol-toml";
import * as clackPrompts from "@clack/prompts";

import { codexHomePath } from "../runtime/codex-home.mjs";
import {
  deepseekProviderDefinition,
} from "../runtime/model-provider-definitions.mjs";
import {
  loadManagedModelProviderSettings,
  loadPrimaryModelProvider,
  managedModelProviderRoleConfigPath,
  withManagedModelCatalogSettings,
  withPreservedManagedModelCatalogSettings,
} from "../runtime/model-provider-runtime.mjs";
import { writePrivateFileAtomic } from "../runtime/private-file.mjs";
import {
  createManagedProviderMarker,
} from "../runtime/model-provider-profile.mjs";
import {
  assertThirdPartyRoleAvailable,
  configureThirdPartyRole,
} from "./agents.mjs";
import { runModelProviderDefaultSetup } from "./model-provider-default-setup.mjs";
import {
  applyExclusiveProviderConfig,
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

class DeepseekSetupCancelled extends Error {}

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
    const codexHome = codexHomePath(environment);
    const configPath = join(codexHome, "config.toml");
    const roleConfigPath = managedModelProviderRoleConfigPath(environment);
    const profilePath = join(codexHome, deepseekProviderDefinition.profileFileName);
    const gatewayProfilePath = join(
      codexHome,
      deepseekProviderDefinition.managedMarkerFileName,
    );
    const catalogPath = join(codexHome, deepseekProviderDefinition.catalogFileName);
    const manifestPath = join(
      codexHome,
      deepseekProviderDefinition.catalogManifestFileName,
    );
    const backupDirectory = join(codexHome, deepseekProviderDefinition.backupDirectoryName);
    const backupPath = join(backupDirectory, "config.toml");
    const profileBackupPath = join(
      backupDirectory,
      deepseekProviderDefinition.profileFileName,
    );
    const gatewayProfileBackupPath = join(
      backupDirectory,
      deepseekProviderDefinition.managedMarkerFileName,
    );
    const roleConfigBackupPath = join(
      backupDirectory,
      "sf-agent.config.toml",
    );
    const backupStatePath = join(backupDirectory, "state.json");
    if (choice === "3") {
      output.write("恢复会覆盖 DeepSeek 安装后对 ~/.codex/config.toml 做的其他修改。\n");
      if (!await prompt.confirm("确认恢复首次安装前的配置？", false)) {
        output.write("已取消，未修改任何文件。\n");
        return undefined;
      }
      return restoreInitialConfig({
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
        output,
      });
    }
    const mode = choice === "1" ? "switching" : "exclusive";
    assertThirdPartyRoleAvailable(environment);
    if (mode === "switching") {
      output.write(
        "\n切换模式保留 OpenAI 默认；DeepSeek 模型、Provider 与 API Key 全部保存在独立 Profile。\n",
      );
    }
    if (mode === "exclusive") {
      const primary = loadPrimaryModelProvider(environment);
      if (primary !== "openai" && primary !== providerId) {
        throw new Error(`请先恢复当前固定 Provider：${primary}`);
      }
      output.write("\n固定模式会修改 ~/.codex/config.toml，并将 DeepSeek API Key 写入该 0600 文件。\n");
      if (!await prompt.confirm("确认继续并先备份原配置？", false)) {
        output.write("已取消，未修改任何文件。\n");
        return undefined;
      }
    }
    const apiKey = await askApiKey(prompt);
    const autoCompactPercent = await askAutoCompact(prompt);

    const downloaded = await downloadDeepseekCatalog(fetchImpl);
    const contextWindow = downloaded.catalog.models?.find(
      (model) => model?.slug === supportedModel,
    )?.context_window;
    if (
      autoCompactPercent !== undefined
      && (!Number.isSafeInteger(contextWindow) || contextWindow <= 0)
    ) {
      throw new Error("DeepSeek 模型目录缺少上下文窗口，未修改配置");
    }
    const defaultCatalog = withManagedModelCatalogSettings(
      downloaded.catalog,
      deepseekProviderDefinition,
      {
        model: supportedModel,
        reasoningEffort: deepseekProviderDefinition.defaultReasoningEffort,
        ...(autoCompactPercent === undefined
          ? {}
          : {
              autoCompactLimit: Math.round(
                contextWindow * autoCompactPercent / 100,
              ),
            }),
      },
    );
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
    let rollbackGuards;
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
      const previous = await loadPreviousManagedSettings({
        environment,
        gatewayProfilePath,
        gatewayProfileBackupPath,
        backupStatePath,
      });
      const selectedModel = previous?.model ?? supportedModel;
      const managedCatalog = withPreservedManagedModelCatalogSettings(
        defaultCatalog,
        deepseekProviderDefinition,
        previous?.models,
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
      await writePrivateFileAtomic(manifestPath, `${JSON.stringify({
        source: deepseekSetupScriptUrl,
        sha256: downloaded.sha256,
        downloadedAt: new Date().toISOString(),
      }, null, 2)}\n`);
      await replaceOptionalFile(configPath, configContent);
      await replaceOptionalFile(profilePath, profileContent);
      await replaceOptionalFile(gatewayProfilePath, gatewayProfileContent);
      await setBackupRestoredState(backupStatePath, false);
      rollbackGuards = await snapshotFiles(installationPaths);
      await configureRole(providerId, selectedModel, environment);
      if (mode === "switching") {
        output.write(`\nOpenAI 默认模型与认证保持不变：${configPath}\n`);
        output.write(`DeepSeek CLI Profile 已保存：${profilePath}\n`);
        output.write("已将共享第三方子代理（agents.external）切换到 DeepSeek。\n");
      } else {
        output.write(`\nDeepSeek 固定配置已保存：${configPath}\n`);
        output.write("已将共享第三方子代理（agents.external）切换到 DeepSeek。\n");
      }
    } catch (error) {
      if (rollbackGuards === undefined) throw error;
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
    output.write(`模型目录已从官方脚本下载：${catalogPath}\n`);
    output.write(mode === "switching"
      ? `原生 Codex 使用 OpenAI：codex；使用 DeepSeek：codex --profile ${deepseekProviderDefinition.codexProfileName}\n共享 TUI：codexc remote；DeepSeek 共享 TUI：codexc remote --profile ${deepseekProviderDefinition.profileName}\n`
      : `原生 Codex 和 Gateway 将默认使用 ${supportedModel}。\n`);
    output.write("请重启 Gateway 与 App Server：codexc service restart all\n");
    return {
      mode,
      configPath,
      profilePath,
      gatewayProfilePath,
      catalogPath,
      backupPath,
    };
  } catch (error) {
    if (allowBack && error instanceof DeepseekSetupCancelled) {
      return { action: "back" };
    }
    throw error;
  } finally {
    prompt.close();
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
  const flash = catalog.models.find((model) => model?.slug === supportedModel);
  if (!flash || typeof flash !== "object") {
    throw new Error(`DeepSeek 官方模型目录缺少 ${supportedModel}`);
  }
  return catalog;
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
  output,
}) {
  let state;
  try {
    state = JSON.parse(await readFile(backupStatePath, "utf8"));
  } catch {
    throw new Error("未找到可恢复的 Codex 初始配置");
  }
  if (
    state.originalRoleConfigExisted !== undefined
    && typeof state.originalRoleConfigExisted !== "boolean"
  ) {
    throw new Error("Codex 初始配置备份状态无效");
  }
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
  output.write("已恢复安装前的 Codex 配置；备份目录保留以便审计。\n");
  output.write("请重启 Gateway 与 App Server：codexc service restart all\n");
  return {
    mode: "restored",
    configPath,
    profilePath,
    gatewayProfilePath,
    catalogPath,
    backupPath,
  };
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
    if (/^sk-[^\s"]+$/u.test(apiKey)) return apiKey;
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
