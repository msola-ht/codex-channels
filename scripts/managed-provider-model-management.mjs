import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import * as clackPrompts from "@clack/prompts";
import { codexHomePath } from "../runtime/codex-home.mjs";
import { loadManagedModelProviderDefinitions, isManagedProviderModelValid, managedProviderAccountFamilyForDefinition } from "../runtime/model-provider-definitions.mjs";
import { ccgAccountsFilePath } from "../runtime/ccg-accounts.mjs";
import { opencodeGoAccountsFilePath } from "../runtime/opencode-go-accounts.mjs";
import { managedProviderDirectory, managedProviderMarkerPath, loadManagedModelProviderSettings, withManagedModelCatalogSettings, withPreservedManagedModelCatalogSettings, writeManagedModelProviderCatalogUpdates } from "../runtime/model-provider-runtime.mjs";
import { createResponsesModelCatalog } from "../runtime/model-provider-responses-catalog.mjs";
import { thirdPartyCodingInstructions } from "../runtime/third-party-coding-instructions.mjs";
import { readModelTemplateBindings } from "../runtime/model-template-bindings.mjs";
import { withModelProviderManagementTransaction } from "./model-provider-management-transaction.mjs";
import { snapshotProviderFiles, assertProviderFileSnapshots } from "./managed-provider-files.mjs";
import { validateModelCatalogWithCodex } from "./model-catalog-validation.mjs";
import { validateEnabledModelSelection, promptEnabledProviderModels } from "./provider-model-selection.mjs";
import { downloadDeepseekCatalog } from "./deepseek-setup.mjs";
import { createCcgCatalogWithTemplateBindings, createOpencodeGoCatalogWithTemplateBindings } from "./provider-model-catalog.mjs";
import { writeGatewayConfigActivationNotice } from "./config-activation-notice.mjs";
import { configActivationResult } from "./config-activation-result.mjs";

function definitionFor(provider, environment) {
  const definition = loadManagedModelProviderDefinitions(environment).find(entry => entry.id === provider);
  if (definition && ["ccg", "opencode-go"].includes(definition.storageId)) return definition;
  throw new Error("此模型管理入口必须明确选择 CCG 或 OCG 账户");
}

/** Existing catalogues remain the enabled set; no hidden candidate database. */
export async function updateManagedProviderModels(provider, { environment = process.env, editCatalog } = {}) {
  const definition = definitionFor(provider, environment);
  if (typeof editCatalog !== "function") throw new Error("缺少模型目录编辑操作");
  return withModelProviderManagementTransaction(environment, async () => {
    const definitions = loadManagedModelProviderDefinitions(environment).filter(entry => entry.storageId === definition.storageId);
    const providers = loadManagedModelProviderSettings(environment).filter(entry => definitions.some(definition => definition.id === entry.provider));
    if (!providers.some(entry => entry.provider === provider)) throw new Error("请先完成该账户配置，再管理模型目录");
    const directory = managedProviderDirectory(environment, definition);
    const catalogPath = join(directory, definition.catalogFileName);
    const manifestPath = join(directory, definition.catalogManifestFileName);
    const snapshots = snapshotProviderFiles([
      catalogPath, manifestPath, `${catalogPath}.backup`, `${manifestPath}.backup`,
      join(codexHomePath(environment), "config.toml"),
      definition.storageId === "ccg" ? ccgAccountsFilePath(environment) : opencodeGoAccountsFilePath(environment),
      ...definitions.flatMap(entry => [managedProviderMarkerPath(environment, entry), join(codexHomePath(environment), entry.profileFileName)]),
    ], environment);
    const original = snapshots.find(entry => entry.path === catalogPath)?.content;
    const manifest = snapshots.find(entry => entry.path === manifestPath)?.content;
    if (!original || !manifest) throw new Error("账户模型目录或来源文件缺失，请先恢复文件");
    const source = JSON.parse(manifest.toString("utf8"));
    if (!source || typeof source !== "object" || Array.isArray(source) || typeof source.source !== "string" || !source.source) {
      throw new Error("账户模型来源清单无效，未更新目录");
    }
    const current = JSON.parse(original.toString("utf8"));
    const previousBindings = readModelTemplateBindings(source, current.models.map(model => model.slug));
    const templateBindings = structuredClone(previousBindings);
    const requiredModels = [...new Set(providers.map(entry => entry.model))];
    const next = await editCatalog({ catalog: structuredClone(current), templateBindings, requiredModels, definition, previousModels: providers[0].models });
    if (next === undefined) return { action: "back", activation: "none" };
    if (!Array.isArray(next?.models)) throw new Error("模型目录缺少 models");
    if (current.models.some(model => !next.models.some(candidate => candidate?.slug === model.slug))) {
      throw new Error("启用选择不能移除已保存模型；请从统一模型管理入口预览并移除");
    }
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
    const nextBindings = readModelTemplateBindings({ modelTemplates: templateBindings }, next.models.map(model => model.slug));
    if (isDeepStrictEqual(current, next) && isDeepStrictEqual(previousBindings, nextBindings)) {
      await assertProviderFileSnapshots(snapshots);
      return { action: "unchanged", activation: "none", models: next.models.map(entry => entry.slug) };
    }
    await validateModelCatalogWithCodex(next, environment);
    await assertProviderFileSnapshots(snapshots);
    const nextManifest = { ...source, updatedAt: new Date().toISOString(),
      ...(source.modelTemplates !== undefined || Object.keys(nextBindings).length ? { modelTemplates: nextBindings } : {}),
    };
    writeManagedModelProviderCatalogUpdates(provider, new Map([
      [`${catalogPath}.backup`, original.toString("utf8")], [`${manifestPath}.backup`, manifest.toString("utf8")],
      [catalogPath, `${JSON.stringify(next, null, 2)}\n`],
      [manifestPath, `${JSON.stringify(nextManifest, null, 2)}\n`],
    ]), new Map(snapshots.map(snapshot => [snapshot.path, snapshot.content?.toString("utf8")])), environment);
    return { action: "catalog-updated", activation: "restart-all", models: next.models.map(entry => entry.slug) };
  });
}

export async function runManagedProviderModelSetup(provider, { environment = process.env, prompts = clackPrompts, output = process.stdout, downloadCatalog = downloadDeepseekCatalog } = {}) {
  if (provider === "ccg" || provider === "ocg") {
    const storageId = provider === "ccg" ? "ccg" : "opencode-go";
    const accounts = loadManagedModelProviderDefinitions(environment).filter(entry => entry.storageId === storageId);
    if (!accounts.length) throw new Error("请先配置账户");
    provider = accounts[0].id;
  }
  const definition = definitionFor(provider, environment);
  const displayName = managedProviderAccountFamilyForDefinition(definition).definition.displayName;
  const result = await updateManagedProviderModels(provider, { environment, editCatalog: async ({ catalog, templateBindings, requiredModels }) => {
    const action = await prompts.select({ message: `${displayName} 模型目录`, options: [
      { value: "select", label: "查看启用模型", hint: "移除请使用统一模型管理入口" },
      { value: "add", label: "添加第三方 Responses 模型", hint: "按上游说明填写准确 ID 和能力" },
      { value: "templates", label: "发现／导入 DS 新模型", hint: "只添加选中的新模型，已有模型使用统一模板更新" },
      { value: "back", label: "返回" },
    ] });
    if (prompts.isCancel(action) || action === "back") return undefined;
    if (action === "select") {
      output.write(`${catalog.models.map(entry => `  ${entry.slug}${requiredModels.includes(entry.slug) ? "（账户默认）" : ""}`).join("\n")}\n移除请使用统一模型管理入口。\n`);
      return undefined;
    }
    const previousIds = catalog.models.map(entry => entry.slug);
    let discovered;
    if (action === "add") {
      const model = await promptAdditionalModel(prompts, definition, previousIds);
      if (!model) return undefined;
      catalog.models.push(model);
    } else if (action === "templates") {
      const downloaded = await downloadCatalog(globalThis.fetch);
      discovered = (definition.storageId === "ccg" ? createCcgCatalogWithTemplateBindings : createOpencodeGoCatalogWithTemplateBindings)(downloaded.catalog);
      catalog.models.push(...discovered.catalog.models.filter(model => !previousIds.includes(model.slug)));
    } else if (action !== "select") throw new Error("未知模型目录操作");
    const enabled = await promptEnabledProviderModels(prompts, output, {
      label: displayName,
      models: catalog.models.map(entry => ({ id: entry.slug, name: entry.display_name, reasoningEffort: entry.default_reasoning_level })),
      enabledModels: action === "add" ? catalog.models.map(entry => entry.slug) : previousIds,
      requiredModels,
      retainedModels: previousIds,
    });
    if (!enabled) return undefined;
    const additions = catalog.models.filter(entry => enabled.includes(entry.slug) && !previousIds.includes(entry.slug));
    if (!additions.length) return { ...catalog, models: catalog.models.filter(entry => previousIds.includes(entry.slug)) };
    const generated = discovered
      ? withPreservedManagedModelCatalogSettings({ ...discovered.catalog, models: additions }, definition, []).models
      : additions;
    if (discovered) {
      for (const model of generated) templateBindings[model.slug] = discovered.templateBindings[model.slug];
    }
    for (const id of Object.keys(templateBindings)) if (!enabled.includes(id)) delete templateBindings[id];
    return { ...catalog, models: [...catalog.models.filter(entry => previousIds.includes(entry.slug)), ...generated] };
  } });
  if (result.action === "unchanged") output.write("模型目录没有变化，无需保存或重启。\n");
  if (result.action === "catalog-updated") {
    output.write(`${displayName} 已保存 ${result.models.length} 个启用模型，并备份原目录。\n`);
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
