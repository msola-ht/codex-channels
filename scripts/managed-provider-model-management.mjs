import { join } from "node:path";
import * as clackPrompts from "@clack/prompts";
import { codexHomePath } from "../runtime/codex-home.mjs";
import { commandCodeProviderDefinition, opencodeGoProviderDefinition, loadManagedModelProviderDefinitions, isManagedProviderModelValid } from "../runtime/model-provider-definitions.mjs";
import { ccgAccountsFilePath } from "../runtime/ccg-accounts.mjs";
import { opencodeGoAccountsFilePath } from "../runtime/opencode-go-accounts.mjs";
import { managedProviderDirectory, managedProviderMarkerPath, loadManagedModelProviderSettings, loadManagedModelWindow, withManagedModelCatalogSettings, withPreservedManagedModelCatalogSettings } from "../runtime/model-provider-runtime.mjs";
import { createResponsesModelCatalog } from "../runtime/model-provider-responses-catalog.mjs";
import { thirdPartyCodingInstructions } from "../runtime/third-party-coding-instructions.mjs";
import { withModelProviderManagementTransaction } from "./model-provider-management-transaction.mjs";
import { snapshotProviderFiles, applyProviderFileUpdates, assertProviderFileSnapshots } from "./managed-provider-files.mjs";
import { validateModelCatalogWithCodex } from "./model-catalog-validation.mjs";
import { validateEnabledModelSelection, promptEnabledProviderModels } from "./provider-model-selection.mjs";
import { downloadDeepseekCatalog } from "./deepseek-setup.mjs";
import { createCcgCatalog, createOpencodeGoCatalog } from "./provider-model-catalog.mjs";
import { writeGatewayConfigActivationNotice } from "./config-activation-notice.mjs";
import { configActivationResult } from "./config-activation-result.mjs";

function definitionFor(provider) {
  if (provider === "ccg") return commandCodeProviderDefinition;
  if (provider === "ocg") return opencodeGoProviderDefinition;
  throw new Error("此模型管理入口仅支持 CCG 或 OCG");
}

/** Existing catalogues remain the enabled set; no hidden candidate database. */
export async function updateManagedProviderModels(provider, { environment = process.env, editCatalog } = {}) {
  const definition = definitionFor(provider);
  if (typeof editCatalog !== "function") throw new Error("缺少模型目录编辑操作");
  return withModelProviderManagementTransaction(environment, async () => {
    const definitions = loadManagedModelProviderDefinitions(environment).filter(entry => (entry.storageId ?? entry.id) === (definition.storageId ?? definition.id));
    const providers = loadManagedModelProviderSettings(environment).filter(entry => definitions.some(item => item.id === entry.provider));
    if (!providers.length || providers.length !== definitions.length) throw new Error("请先完成所有账户配置，再管理共享模型目录");
    const directory = managedProviderDirectory(environment, definition);
    const catalogPath = join(directory, definition.catalogFileName);
    const manifestPath = join(directory, definition.catalogManifestFileName);
    const snapshots = snapshotProviderFiles([
      catalogPath, manifestPath, `${catalogPath}.backup`, `${manifestPath}.backup`,
      join(codexHomePath(environment), "config.toml"),
      provider === "ccg" ? ccgAccountsFilePath(environment) : opencodeGoAccountsFilePath(environment),
      ...definitions.flatMap(entry => [managedProviderMarkerPath(environment, entry), join(codexHomePath(environment), entry.profileFileName)]),
    ]);
    const original = snapshots.find(entry => entry.path === catalogPath)?.content;
    const manifest = snapshots.find(entry => entry.path === manifestPath)?.content;
    if (!original || !manifest) throw new Error("共享模型目录或来源文件缺失，请先恢复文件");
    const current = JSON.parse(original.toString("utf8"));
    const requiredModels = [...new Set(providers.map(entry => entry.model))];
    const next = await editCatalog({ catalog: structuredClone(current), requiredModels, definition, previousModels: providers[0].models });
    if (next === undefined) return { action: "back", activation: "none" };
    if (!Array.isArray(next?.models)) throw new Error("模型目录缺少 models");
    validateEnabledModelSelection(next.models.map(entry => entry?.slug), {
      models: next.models.map(entry => ({ id: entry?.slug })), requiredModels,
    });
    for (const model of next.models) {
      if (!isManagedProviderModelValid(definition, model.slug)) throw new Error("模型 ID 不符合该提供商约束");
      // Reuse the runtime capability validation without changing any settings.
      withManagedModelCatalogSettings(next, definition, { model: model.slug, reasoningEffort: model.default_reasoning_level });
    }
    for (const account of providers) {
      if (next.models.find(entry => entry.slug === account.model)?.default_reasoning_level !== account.reasoningEffort) {
        throw new Error("不能更改账户默认模型的思考等级；请使用默认模型设置入口");
      }
    }
    await validateModelCatalogWithCodex(next, environment);
    await assertProviderFileSnapshots(snapshots);
    await applyProviderFileUpdates(new Map([
      [`${catalogPath}.backup`, original], [`${manifestPath}.backup`, manifest],
      [catalogPath, `${JSON.stringify(next, null, 2)}\n`],
      [manifestPath, `${JSON.stringify({ source: "user-configured", updatedAt: new Date().toISOString() }, null, 2)}\n`],
    ]), snapshots);
    return { action: "catalog-updated", activation: "restart-all", models: next.models.map(entry => entry.slug) };
  });
}

export async function runManagedProviderModelSetup(provider, { environment = process.env, prompts = clackPrompts, output = process.stdout, downloadCatalog = downloadDeepseekCatalog } = {}) {
  const definition = definitionFor(provider);
  const result = await updateManagedProviderModels(provider, { environment, editCatalog: async ({ catalog, requiredModels, previousModels }) => {
    const action = await prompts.select({ message: `${definition.displayName} 共享模型目录`, options: [
      { value: "select", label: "选择启用模型" },
      { value: "add", label: "添加第三方 Responses 模型", hint: "按上游说明填写准确 ID 和能力" },
      { value: "templates", label: "导入／刷新 DS 模板", hint: "使用该提供商的既有 ID 映射" },
      { value: "back", label: "返回" },
    ] });
    if (prompts.isCancel(action) || action === "back") return undefined;
    const previousIds = catalog.models.map(entry => entry.slug);
    if (action === "add") {
      const model = await promptAdditionalModel(prompts, definition, previousIds);
      if (!model) return undefined;
      catalog.models.push(model);
    } else if (action === "templates") {
      const downloaded = await downloadCatalog(globalThis.fetch);
      let templates = (provider === "ccg" ? createCcgCatalog : createOpencodeGoCatalog)(downloaded.catalog);
      templates = withPreservedManagedModelCatalogSettings(templates, definition, previousModels);
      const previous = new Map(catalog.models.map(entry => [entry.slug, entry]));
      const windows = provider === "ocg" ? loadManagedModelWindow(environment) : [];
      for (const model of templates.models) {
        const old = previous.get(model.slug);
        if (old) {
          if ((old.max_context_window ?? old.context_window) === (model.max_context_window ?? model.context_window)) model.context_window = old.context_window;
        } else {
          const window = windows.find(entry => entry.model === model.slug);
          if (window?.conflicts || window?.windowConflict) throw new Error("同名模型的窗口设置冲突，请先统一设置");
          if (window?.windowPercent !== undefined) {
            model.context_window = Math.round((model.max_context_window ?? model.context_window) * window.windowPercent / 100);
          }
        }
        previous.set(model.slug, model);
      }
      catalog.models = [...previous.values()];
    } else if (action !== "select") throw new Error("未知模型目录操作");
    const enabled = await promptEnabledProviderModels(prompts, output, {
      label: `${definition.displayName}（全部账户及聚合共用）`,
      models: catalog.models.map(entry => ({ id: entry.slug, name: entry.display_name, reasoningEffort: entry.default_reasoning_level })),
      enabledModels: action === "add" ? catalog.models.map(entry => entry.slug) : previousIds, requiredModels,
    });
    if (!enabled) return undefined;
    return { ...catalog, models: catalog.models.filter(entry => enabled.includes(entry.slug)) };
  } });
  if (result.action !== "back") {
    output.write(`${definition.displayName} 已保存 ${result.models.length} 个启用模型，并备份原目录。\n`);
    writeGatewayConfigActivationNotice(output, environment, configActivationResult(result.activation));
  }
  return result;
}

async function promptAdditionalModel(prompts, definition, existing) {
  const confirmed = await prompts.confirm({ message: "已确认此提供商以 Responses 接口支持该模型及工具调用？", initialValue: false });
  if (confirmed !== true) return undefined;
  const id = await prompts.text({ message: "上游模型 ID（准确名称）", validate: value => isManagedProviderModelValid(definition, value) && !existing.includes(value) ? undefined : "请输入有效且未加入目录的模型 ID" });
  if (prompts.isCancel(id)) return undefined;
  const name = await prompts.text({ message: "显示名称", initialValue: id });
  if (prompts.isCancel(name)) return undefined;
  const window = await prompts.text({ message: "上下文窗口（Token，按上游说明填写）", validate: value => Number.isSafeInteger(Number(value)) && Number(value) >= 1024 && Number(value) <= 100_000_000 ? undefined : "请输入 1024–100000000 的整数" });
  if (prompts.isCancel(window)) return undefined;
  const efforts = await prompts.multiselect({ message: "支持的思考等级（不支持思考时仅选 none）", options: ["none", "minimal", "low", "medium", "high", "xhigh", "max"].map(value => ({ value, label: value })), required: true });
  if (prompts.isCancel(efforts)) return undefined;
  if (!Array.isArray(efforts) || !efforts.length) throw new Error("至少选择一个思考等级");
  const effort = await prompts.select({ message: "默认思考等级", options: efforts.map(value => ({ value, label: value })) });
  if (prompts.isCancel(effort)) return undefined;
  const images = await prompts.confirm({ message: "支持图片输入？", initialValue: false });
  if (prompts.isCancel(images)) return undefined;
  const patch = await prompts.confirm({ message: "支持 Codex 自由格式 apply_patch 工具？", initialValue: false });
  if (prompts.isCancel(patch)) return undefined;
  const search = await prompts.confirm({ message: "支持 Codex 客户端 tool_search 工具？", initialValue: false });
  if (prompts.isCancel(search)) return undefined;
  return createResponsesModelCatalog([{ id, name, contextWindow: Number(window), reasoningEfforts: efforts, defaultReasoningEffort: effort,
    supportsImages: images, ...(patch ? { applyPatchToolType: "freeform" } : {}), supportsSearchTool: search,
    instructions: thirdPartyCodingInstructions }], id).models[0];
}
