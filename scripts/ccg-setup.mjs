import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as clackPrompts from "@clack/prompts";
import { parse, stringify } from "smol-toml";

import { codexHomePath } from "../runtime/codex-home.mjs";
import { effectiveCodexBinary, resolveExecutableInvocation } from "../runtime/executable.mjs";
import { writePrivateFileAtomic } from "../runtime/private-file.mjs";
import {
  commandCodeProviderDefinition as definition,
  isManagedProviderApiKeyValid,
  isManagedProviderModelValid,
} from "../runtime/model-provider-definitions.mjs";
import { createManagedProviderMarker } from "../runtime/model-provider-profile.mjs";
import {
  loadManagedModelProviderSettings,
  loadPrimaryModelProvider,
  loadThirdPartyModelProviderRole,
  managedProviderDirectory,
  managedModelProviderRoleConfigPath,
  withManagedModelCatalogSettings,
  withPreservedManagedModelCatalogSettings,
} from "../runtime/model-provider-runtime.mjs";
import {
  createManagedProviderConfiguration,
  hasProviderBaseConfig,
  restoreProviderBaseConfig,
} from "./managed-model-provider-setup.mjs";
import { withModelProviderManagementTransaction } from "./model-provider-management-transaction.mjs";
import {
  applyProviderFileUpdates,
  readOptionalProviderFile,
  snapshotProviderFiles,
} from "./managed-provider-files.mjs";
import { runModelProviderDefaultSetup } from "./model-provider-default-setup.mjs";
import { configActivationResult } from "./config-activation-result.mjs";
import { writeGatewayConfigActivationNotice } from "./config-activation-notice.mjs";
import { deepseekSetupScriptUrl, downloadDeepseekCatalog } from "./deepseek-setup.mjs";
import { createCcgCatalog } from "./provider-model-catalog.mjs";

const maximumCatalogBytes = 2 * 1024 * 1024;

async function validateCcgCatalog(catalog, environment) {
  checkCcgCatalog(catalog);
  const content = `${JSON.stringify(catalog, null, 2)}\n`;
  if (Buffer.byteLength(content) > maximumCatalogBytes) {
    throw new Error("CCG 模型目录不能超过 2 MiB");
  }
  const directory = await mkdtemp(join(tmpdir(), "codexc-ccg-catalog-"));
  try {
    const path = join(directory, "models.json");
    await writePrivateFileAtomic(path, content);
    const validationEnvironment = { ...environment, CODEX_HOME: directory };
    const invocation = resolveExecutableInvocation(
      effectiveCodexBinary("codex", environment),
      ["-c", `model_catalog_json=${JSON.stringify(path)}`, "debug", "models"],
      validationEnvironment,
    );
    // 配置目录与工作目录均隔离；显式目录使用 Codex StaticModelsManager，不请求远端模型。
    const result = spawnSync(invocation.file, invocation.args, {
      cwd: directory, env: validationEnvironment,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
      timeout: 30_000, maxBuffer: 8 * maximumCatalogBytes,
      stdio: ["ignore", "ignore", "pipe"],
    });
    if (result.error || result.status !== 0) {
      throw new Error("CCG 模型目录未通过当前 Codex CLI 校验；请检查完整模型能力字段及 CLI 是否可运行");
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function checkCcgCatalog(catalog) {
  if (!Array.isArray(catalog?.models) || catalog.models.length === 0) {
    throw new Error("CCG 模型目录缺少 models");
  }
  const slugs = new Set();
  for (const entry of catalog.models) {
    if (!isManagedProviderModelValid(definition, entry?.slug) || slugs.has(entry.slug)
      || typeof entry.display_name !== "string" || entry.display_name.length === 0
      || !Array.isArray(entry.input_modalities) || !entry.input_modalities.includes("text")
      || new Set(entry.input_modalities).size !== entry.input_modalities.length
      || entry.input_modalities.some((value) => !["text", "image", "audio"].includes(value))) {
      throw new Error("CCG 模型目录包含无效模型名称或输入能力");
    }
    withManagedModelCatalogSettings(catalog, definition, {
      model: entry.slug, reasoningEffort: entry.default_reasoning_level,
    });
    slugs.add(entry.slug);
  }
  return catalog;
}

export function ccgSetupPaths(environment = process.env) {
  const directory = managedProviderDirectory(environment, definition);
  return {
    config: join(codexHomePath(environment), "config.toml"),
    profile: join(codexHomePath(environment), definition.profileFileName),
    marker: join(directory, definition.managedMarkerFileName),
    catalog: join(directory, definition.catalogFileName),
    manifest: join(directory, definition.catalogManifestFileName),
    backup: join(directory, definition.backupDirectoryName, "config.json"),
  };
}

export async function applyCcgConfiguration({
  apiKey,
  catalog: source,
  model,
  mode = "switching",
  confirmExclusiveConfigChange = false,
}, {
  environment = process.env,
} = {}) {
  if (!["switching", "exclusive"].includes(mode)) throw new Error("CCG 模式无效");
  if (!isManagedProviderApiKeyValid(definition, apiKey)) throw new Error("CCG API Key 无效");
  if (mode === "exclusive" && confirmExclusiveConfigChange !== true) {
    throw new Error("固定模式会修改 Codex 主配置，必须先明确确认");
  }
  return withModelProviderManagementTransaction(environment, async () => {
    const paths = ccgSetupPaths(environment);
    const snapshots = snapshotProviderFiles([
      ...Object.values(paths), managedModelProviderRoleConfigPath(environment),
    ]);
    const primary = loadPrimaryModelProvider(environment);
    if (mode === "exclusive" && !["openai", definition.id].includes(primary)) {
      throw new Error(`请先恢复当前固定 Provider：${primary}`);
    }
    const previous = loadManagedModelProviderSettings(environment)
      .find((item) => item.provider === definition.id);
    const current = await readConfig(paths.config);
    if (!previous && (hasProviderBaseConfig(current, definition)
      || await readOptionalProviderFile(paths.profile) !== undefined
      || await readOptionalProviderFile(paths.marker) !== undefined)) {
      throw new Error("CCG 配置路径已被占用，请先处理现有配置");
    }
    const backup = await readInitialConfig(paths.backup);
    if (previous && !backup) throw new Error("CCG 初始配置备份缺失，请先恢复原始备份");
    const initial = backup ?? { config: current };
    checkCcgCatalog(source);
    if (!source.models.some((entry) => entry.slug === model)) {
      throw new Error("请选择 CCG 模型目录中的模型");
    }
    const catalog = withPreservedManagedModelCatalogSettings(source, definition, previous?.models ?? []);
    checkCcgRole(catalog, environment);
    await validateCcgCatalog(catalog, environment);
    const { config: nextConfig, profile } = createManagedProviderConfiguration(
      current, initial.config, definition, {
        mode, previousMode: previous?.mode,
        apiKey, catalogPath: paths.catalog, catalog, model,
      },
    );
    const updates = new Map([
      [paths.backup, `${JSON.stringify(initial)}\n`],
      [paths.catalog, `${JSON.stringify(catalog, null, 2)}\n`],
      [paths.manifest, `${JSON.stringify({
        source: deepseekSetupScriptUrl,
        downloadedAt: new Date().toISOString(),
      }, null, 2)}\n`],
      [paths.profile, profile === undefined ? undefined : stringify(profile)],
      [paths.marker, stringify(createManagedProviderMarker(definition, mode))],
    ]);
    if (mode === "exclusive" || previous?.mode === "exclusive") {
      updates.set(paths.config, stringify(nextConfig));
    }
    await applyProviderFileUpdates(updates, snapshots);
    return { action: "configured", mode, model, activation: "restart-all" };
  });
}

function checkCcgRole(catalog, environment) {
  const role = loadThirdPartyModelProviderRole(environment);
  if (role?.provider === definition.id) {
    const roleModel = catalog.models.find((entry) => entry.slug === role.model);
    if (!roleModel?.supported_reasoning_levels.some((entry) => entry.effort === role.reasoningEffort)) {
      throw new Error("新 CCG 目录不支持共享第三方子代理当前的模型或思考等级，请先切换或停用该角色");
    }
  }
}

export async function refreshCcgCatalogForUpdate(environment = process.env, options = {}) {
  return withModelProviderManagementTransaction(environment, async () => {
    const paths = ccgSetupPaths(environment);
    const snapshots = snapshotProviderFiles([
      ...Object.values(paths), managedModelProviderRoleConfigPath(environment),
    ]);
    const previous = loadManagedModelProviderSettings(environment)
      .find((item) => item.provider === definition.id);
    if (!previous) return { status: "not-configured" };
    const downloaded = options.downloadCatalog
      ? await options.downloadCatalog()
      : await downloadDeepseekCatalog(options.fetchImpl ?? globalThis.fetch);
    const catalog = withPreservedManagedModelCatalogSettings(
      createCcgCatalog(downloaded.catalog), definition, previous.models,
    );
    const selected = catalog.models.find((entry) => entry.slug === previous.model);
    if (!selected) throw new Error("新 CCG 目录不支持当前默认模型，请先选择受支持的模型");
    checkCcgRole(catalog, environment);
    await validateCcgCatalog(catalog, environment);
    const updates = new Map([
      [paths.catalog, `${JSON.stringify(catalog, null, 2)}\n`],
      [paths.manifest, `${JSON.stringify({
        source: deepseekSetupScriptUrl, downloadedAt: new Date().toISOString(),
      }, null, 2)}\n`],
    ]);
    if (previous.mode === "switching") {
      const profile = await readConfig(paths.profile);
      profile.model_reasoning_effort = selected.default_reasoning_level;
      updates.set(paths.profile, stringify(profile));
    }
    await applyProviderFileUpdates(updates, snapshots);
    return { status: "updated", provider: definition.id };
  });
}

export async function removeCcgConfiguration({ confirmRemove = false } = {}, {
  environment = process.env,
} = {}) {
  if (confirmRemove !== true) throw new Error("删除 CCG 前必须明确确认");
  return withModelProviderManagementTransaction(environment, async () => {
    const paths = ccgSetupPaths(environment);
    const snapshots = snapshotProviderFiles(Object.values(paths));
    const current = loadManagedModelProviderSettings(environment)
      .find((item) => item.provider === definition.id);
    if (!current) throw new Error("CCG 尚未配置");
    if (loadThirdPartyModelProviderRole(environment)?.provider === definition.id) {
      throw new Error("请先切换或停用 CCG 共享第三方子代理");
    }
    const initial = await readInitialConfig(paths.backup);
    if (!initial) throw new Error("CCG 初始配置备份缺失");
    const updates = new Map([
      [paths.profile, undefined], [paths.marker, undefined],
      [paths.catalog, undefined], [paths.manifest, undefined],
    ]);
    if (current.mode === "exclusive") {
      updates.set(paths.config, stringify(restoreProviderBaseConfig(
        await readConfig(paths.config), initial.config, definition,
      )));
    }
    await applyProviderFileUpdates(updates, snapshots);
    return { action: "removed", activation: "restart-all" };
  });
}

export async function runCcgSetup({
  environment = process.env,
  output = process.stdout,
  prompts = clackPrompts,
  downloadCatalog = downloadDeepseekCatalog,
  fetchImpl = globalThis.fetch,
} = {}) {
  const action = await prompts.select({
    message: "CCG（CommandCode）设置",
    options: [
      { value: "switching", label: "配置切换模式" },
      { value: "exclusive", label: "配置固定模式" },
      { value: "settings", label: "修改默认模型与思考等级" },
      { value: "remove", label: "删除 CCG" },
      { value: "back", label: "返回" },
    ],
  });
  if (prompts.isCancel(action) || action === "back") return { action: "back" };
  if (action === "settings") {
    return runModelProviderDefaultSetup({
      allowBack: true, provider: definition.id, environment, output, prompts,
    });
  }
  let result;
  if (action === "remove") {
    const confirmed = await prompts.confirm({
      message: "删除 CCG 配置？固定模式将恢复首次配置前的 Provider 设置，备份保留。",
      initialValue: false,
    });
    if (confirmed !== true) return { action: "back" };
    result = await removeCcgConfiguration({ confirmRemove: true }, { environment });
  } else {
    if (!["switching", "exclusive"].includes(action)) throw new Error("未知 CCG 设置操作");
    if (action === "exclusive") {
      const confirmed = await prompts.confirm({
        message: "固定模式会备份并修改 Codex 主配置，确认继续？",
        initialValue: false,
      });
      if (confirmed !== true) return { action: "back" };
    }
    const apiKey = await prompts.password({
      message: "CommandCode API Key（保存到本机 0600 私有配置）",
      validate: (value) => isManagedProviderApiKeyValid(definition, value)
        ? undefined : "CCG API Key 无效",
    });
    if (prompts.isCancel(apiKey)) return { action: "back" };
    const downloaded = await downloadCatalog(fetchImpl);
    const catalog = createCcgCatalog(downloaded.catalog);
    const model = await prompts.select({
      message: "选择 CCG 默认模型（来自目录文件）",
      options: catalog.models.map((entry) => ({ value: entry.slug, label: entry.display_name })),
    });
    if (prompts.isCancel(model)) return { action: "back" };
    result = await applyCcgConfiguration({
      apiKey, catalog, model, mode: action, confirmExclusiveConfigChange: action === "exclusive",
    }, { environment });
    output.write("CCG 已配置；通过 /model 选择模型，或在切换模式使用 codexc remote --profile sf-ccg。\n");
  }
  writeGatewayConfigActivationNotice(output, environment, configActivationResult("restart-all"));
  return result;
}

async function readConfig(path) {
  const content = await readOptionalProviderFile(path);
  if (content === undefined) return {};
  try { return parse(content.toString("utf8")); } catch {
    throw new Error("CCG 配置无法安全解析");
  }
}

async function readInitialConfig(path) {
  const content = await readOptionalProviderFile(path);
  if (content === undefined) return undefined;
  try {
    const value = JSON.parse(content.toString("utf8"));
    if (!value?.config || typeof value.config !== "object" || Array.isArray(value.config)) {
      throw new Error("invalid backup");
    }
    return value;
  } catch {
    throw new Error("CCG 初始配置备份无效");
  }
}
