import { randomUUID } from "node:crypto";
import { join } from "node:path";
import * as clackPrompts from "@clack/prompts";
import { parse, stringify } from "smol-toml";
import { codexHomePath } from "../runtime/codex-home.mjs";
import { clinePassProviderDefinition as definition, isManagedProviderApiKeyValid } from "../runtime/model-provider-definitions.mjs";
import { createManagedProviderMarker } from "../runtime/model-provider-profile.mjs";
import { createResponsesModelCatalog } from "../runtime/model-provider-responses-catalog.mjs";
import { managedProviderDirectory, loadManagedModelProviderSettings, loadPrimaryModelProvider } from "../runtime/model-provider-runtime.mjs";
import { createManagedProviderConfiguration, hasProviderBaseConfig, restoreProviderBaseConfig } from "./managed-model-provider-setup.mjs";
import { applyProviderFileUpdates, snapshotProviderFiles } from "./managed-provider-files.mjs";
import { withModelProviderManagementTransaction } from "./model-provider-management-transaction.mjs";
import { validateModelCatalogWithCodex } from "./model-catalog-validation.mjs";
import { stopManagedAccountForRemoval } from "./managed-provider-account-runtime.mjs";
import { configActivationResult } from "./config-activation-result.mjs";
import { writeGatewayConfigActivationNotice } from "./config-activation-notice.mjs";

export function clinePassSetupPaths(environment = process.env) {
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

export function createClinePassCatalog(contextWindow) {
  return { models: createResponsesModelCatalog([{
    id: definition.defaultModel, name: "Cline Pass DeepSeek V4.1 Flash",
    contextWindow, reasoningEfforts: ["none"], defaultReasoningEffort: "none", supportsImages: true,
  }], definition.defaultModel).models };
}

export async function applyClinePassConfiguration({ apiKey, contextWindow, mode = "switching", confirmExclusiveConfigChange = false }, { environment = process.env } = {}) {
  if (!isManagedProviderApiKeyValid(definition, apiKey)) throw new Error("Cline Pass API Key 无效");
  if (!["switching", "exclusive"].includes(mode)) throw new Error("Cline Pass 模式无效");
  if (mode === "exclusive" && !confirmExclusiveConfigChange) throw new Error("固定模式修改 Codex 主配置前必须确认");
  const catalog = createClinePassCatalog(contextWindow);
  await validateModelCatalogWithCodex(catalog, environment);
  return withModelProviderManagementTransaction(environment, async () => {
    const paths = clinePassSetupPaths(environment);
    const snapshots = snapshotProviderFiles(Object.values(paths));
    const content = key => snapshots.find(item => item.path === paths[key]).content?.toString("utf8");
    const current = content("config") === undefined ? {} : parsePrivateConfig(content("config"));
    const previous = loadManagedModelProviderSettings(environment).find(item => item.provider === definition.id);
    if (!previous && (content("profile") !== undefined || content("marker") !== undefined || content("catalog") !== undefined || content("manifest") !== undefined || hasProviderBaseConfig(current, definition))) throw new Error("Cline Pass 配置路径已被占用");
    if (mode === "exclusive" && !["openai", definition.id].includes(loadPrimaryModelProvider(environment))) throw new Error("请先恢复当前固定 Provider");
    const backup = content("backup") === undefined ? undefined : parsePrivateBackup(content("backup"));
    if (previous && !backup?.config) throw new Error("Cline Pass 初始备份缺失");
    const initial = previous && !(previous.mode === "switching" && mode === "exclusive") ? backup.config : current;
    const { config, profile } = createManagedProviderConfiguration(current, initial, definition, {
      mode, previousMode: previous?.mode, apiKey, catalogPath: paths.catalog, catalog, model: definition.defaultModel,
    });
    const updates = new Map([
      [paths.backup, `${JSON.stringify({ config: initial })}\n`],
      [paths.catalog, `${JSON.stringify(catalog, null, 2)}\n`],
      [paths.manifest, `${JSON.stringify({ source: "https://docs.cline.bot/api/chat-completions", contextWindowSource: "user" })}\n`],
      [paths.profile, profile === undefined ? undefined : stringify(profile)],
      [paths.marker, stringify(createManagedProviderMarker(definition, mode))],
    ]);
    if (content("backup") !== undefined && JSON.stringify(backup.config) !== JSON.stringify(initial)) {
      const archive = `${paths.backup}.${randomUUID()}`;
      snapshots.push(...snapshotProviderFiles([archive]));
      updates.set(archive, content("backup"));
    }
    if (mode === "exclusive" || previous?.mode === "exclusive") updates.set(paths.config, stringify(config));
    await applyProviderFileUpdates(updates, snapshots);
    return { action: "configured", provider: definition.id, mode, activation: "restart-all" };
  });
}

export async function removeClinePassConfiguration({ confirmRemove = false } = {}, options = {}) {
  if (!confirmRemove) throw new Error("移除 Cline Pass 前必须确认");
  const environment = options.environment ?? process.env;
  return withModelProviderManagementTransaction(environment, async () => {
    const paths = clinePassSetupPaths(environment);
    const previous = loadManagedModelProviderSettings(environment).find(item => item.provider === definition.id);
    if (!previous) throw new Error("Cline Pass 尚未配置");
    const snapshots = snapshotProviderFiles(Object.values(paths));
    const content = key => snapshots.find(item => item.path === paths[key]).content?.toString("utf8");
    const updates = new Map([paths.profile, paths.marker, paths.catalog, paths.manifest].map(path => [path, undefined]));
    if (previous.mode === "exclusive") {
      if (content("backup") === undefined) throw new Error("Cline Pass 初始备份缺失");
      const backup = parsePrivateBackup(content("backup"));
      updates.set(paths.config, stringify(restoreProviderBaseConfig(parsePrivateConfig(content("config")), backup.config, definition)));
    }
    await stopManagedAccountForRemoval(definition.id, options);
    await applyProviderFileUpdates(updates, snapshots);
    return { action: "removed", activation: "restart-all" };
  });
}

export async function runClinePassSetup({ environment = process.env, prompts = clackPrompts, output = process.stdout } = {}) {
  const configured = loadManagedModelProviderSettings(environment).some(item => item.provider === definition.id);
  const action = await prompts.select({ message: "Cline Pass", options: [
    { value: "configure", label: configured ? "重新配置" : "配置 Cline Pass" },
    ...(configured ? [{ value: "remove", label: "移除配置" }] : []),
    { value: "back", label: "返回" },
  ] });
  if (prompts.isCancel(action) || action === "back") return { action: "back" };
  let result;
  if (action === "remove") {
    if (await prompts.confirm({ message: "移除 Cline Pass 配置与 Key，保留备份和历史统计？", initialValue: false }) !== true) return { action: "back" };
    result = await removeClinePassConfiguration({ confirmRemove: true }, { environment });
  } else {
    const apiKey = await prompts.password({ message: "Cline Pass API Key", validate: value => isManagedProviderApiKeyValid(definition, value) ? undefined : "请输入有效 API Key" });
    if (prompts.isCancel(apiKey)) return { action: "back" };
    const contextWindow = await prompts.text({ message: "模型上下文窗口（Token，按账户提供的模型能力填写）", validate: value => /^\d+$/u.test(value ?? "") && Number.isSafeInteger(Number(value)) && Number(value) >= 4096 ? undefined : "请输入至少 4096 的整数" });
    if (prompts.isCancel(contextWindow)) return { action: "back" };
    const mode = await prompts.select({ message: "运行模式", options: [{ value: "switching", label: "切换模式" }, { value: "exclusive", label: "固定模式" }] });
    if (prompts.isCancel(mode)) return { action: "back" };
    if (mode === "exclusive" && await prompts.confirm({ message: "固定模式会修改 Codex 主配置，是否继续？", initialValue: false }) !== true) return { action: "back" };
    result = await applyClinePassConfiguration({ apiKey, contextWindow: Number(contextWindow), mode, confirmExclusiveConfigChange: mode === "exclusive" }, { environment });
  }
  writeGatewayConfigActivationNotice(output, environment, configActivationResult(result.activation));
  return result;
}

function parsePrivateConfig(content) {
  try { return parse(content); } catch {
    throw new Error("Codex 配置无法解析；请检查私有配置文件");
  }
}
function parsePrivateBackup(content) {
  try {
    const value = JSON.parse(content);
    if (!value?.config || typeof value.config !== "object" || Array.isArray(value.config)) throw new Error("invalid backup");
    return value;
  } catch {
    throw new Error("Cline Pass 初始备份无效");
  }
}
