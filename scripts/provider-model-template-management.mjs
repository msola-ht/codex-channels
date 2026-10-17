import { createHash, createHmac, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { codexHomePath } from "../runtime/codex-home.mjs";
import { normalizeDeepseekCatalogCapabilities } from "../runtime/model-catalog.mjs";
import { completeCatalogPrompts, completeDefinitionPrompts } from "../runtime/model-template-catalog.mjs";
import { loadManagedModelProviderDefinitions, managedProviderAccountFamilies } from "../runtime/model-provider-definitions.mjs";
import { managedProviderDirectory, managedProviderMarkerPath, writeManagedModelProviderCatalogUpdates } from "../runtime/model-provider-runtime.mjs";
import { readResponsesModelCatalog, validateResponsesModels } from "../runtime/model-provider-responses-catalog.mjs";
import { loadProviderModelCatalogs, ProviderModelManagementError } from "./provider-model-management.mjs";
import { loadResponsesModelTemplates } from "./responses-model-templates.mjs";
import { previewCustomProviderModelsSave, applyCustomProviderModelsSave } from "./custom-primary-provider-management.mjs";
import { snapshotProviderFiles, assertProviderFileSnapshots } from "./managed-provider-files.mjs";
import { withModelProviderManagementTransaction } from "./model-provider-management-transaction.mjs";
import { validateModelCatalogWithCodex } from "./model-catalog-validation.mjs";

const revisionSecret = randomBytes(32);
const fields = {
  custom: {
    prompts: ["instructions", "modelMessages"],
    capabilities: ["description", "maxContextWindow", "reasoningEfforts", "reasoningDescriptions", "supportsImages", "supportsImageDetailOriginal", "supportsVerbosity", "defaultVerbosity", "supportsReasoningSummary", "defaultReasoningSummary", "effectiveContextWindowPercent"],
  },
  managed: {
    prompts: ["base_instructions", "model_messages"],
    capabilities: ["description", "max_context_window", "supported_reasoning_levels", "input_modalities", "supports_image_detail_original", "support_verbosity", "default_verbosity", "supports_reasoning_summary_parameter", "default_reasoning_summary", "effective_context_window_percent"],
  },
};
const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Only persisted CP mappings and the official DS family establish template identity. */
export async function loadProviderModelTemplateTargets(provider, { environment = process.env } = {}) {
  const { catalogs } = await loadProviderModelCatalogs({ environment });
  const catalog = catalogs.find(entry => entry.provider === provider);
  if (!catalog) throw invalid("provider-not-configured", "provider", "提供商账户不存在或无法读取");
  if (provider.startsWith("cp-")) {
    return readResponsesModelCatalog(environment, provider).definitions.filter(entry => entry.template)
      .map(entry => ({ model: entry.id, displayName: entry.name, source: entry.template.source, sourceModel: entry.template.model }));
  }
  const definition = loadManagedModelProviderDefinitions(environment).find(entry => entry.id === provider);
  if (definition?.storageId !== "deepseek") return [];
  return catalog.models.map(entry => ({ model: entry.id, displayName: entry.displayName, source: "deepseek", sourceModel: entry.id }));
}

export async function previewProviderModelTemplateUpdate(input, { environment = process.env } = {}) {
  return (await buildPlan(input, environment)).preview;
}

export async function applyProviderModelTemplateUpdate(input, { environment = process.env, preview } = {}) {
  return withModelProviderManagementTransaction(environment, async () => {
    const plan = await buildPlan(input, environment);
    if (!preview || preview.revision !== plan.preview.revision) throw invalid("stale-preview", "revision", "账户目录、模板或更新范围已变化，请重新对比");
    if (!plan.preview.willChange) return { action: "unchanged", activation: "none" };
    if (plan.customInput) {
      await applyCustomProviderModelsSave(plan.customInput, {
        environment, preview: plan.customPreview, expectedCatalogContent: plan.previousContent,
      });
    } else {
      await assertProviderFileSnapshots(plan.snapshots);
      writeManagedModelProviderCatalogUpdates(input.provider, plan.updates,
        new Map(plan.snapshots.map(snapshot => [snapshot.path, snapshot.content?.toString("utf8")])), environment);
    }
    return { action: "updated", activation: plan.preview.activation };
  });
}

async function buildPlan(input, environment) {
  if (!input || typeof input !== "object" || Array.isArray(input)
    || Object.keys(input).some(key => !["provider", "model", "sections"].includes(key))
    || typeof input.provider !== "string" || typeof input.model !== "string"
    || !Array.isArray(input.sections) || input.sections.length < 1 || input.sections.length > 2
    || new Set(input.sections).size !== input.sections.length
    || input.sections.some(section => !["prompts", "capabilities"].includes(section))) {
    throw invalid("invalid-input", "sections", "请选择准确账户、模型与非空更新范围");
  }
  const sections = ["prompts", "capabilities"].filter(section => input.sections.includes(section));
  const target = (await loadProviderModelTemplateTargets(input.provider, { environment })).find(entry => entry.model === input.model);
  if (!target) throw invalid("template-unavailable", "model", "模型没有可更新的模板关联；请先显式导入模板");
  const plan = input.provider.startsWith("cp-")
    ? await buildCustomPlan(input, target, sections, environment)
    : await buildManagedPlan(input, target, sections, environment);
  const changes = Object.keys(plan.after).concat(Object.keys(plan.before))
    .filter((key, index, keys) => keys.indexOf(key) === index && !isDeepStrictEqual(plan.before[key], plan.after[key]))
    .map(field => ({ field, before: plan.before[field], after: plan.after[field] }));
  const preview = { provider: input.provider, model: input.model, source: target.source, sourceModel: target.sourceModel,
    sections, changes, willChange: changes.length > 0,
    activation: changes.length === 0 ? "none" : plan.customInput ? "restart-all" : "restart-app-server" };
  const revision = createHmac("sha256", revisionSecret).update(JSON.stringify({ preview,
    sourceRevision: plan.sourceRevision, targetRevision: plan.customPreview?.revision ?? plan.snapshots.map(snapshot => [snapshot.path, snapshot.content?.toString("base64") ?? null]),
  })).digest("hex");
  return { ...plan, preview: { ...preview, revision } };
}

function selectedFields(before, template, kind, sections) {
  const after = structuredClone(before);
  for (const field of sections.flatMap(section => fields[kind][section])) {
    if (Object.hasOwn(template, field)) after[field] = structuredClone(template[field]);
    else delete after[field];
  }
  return after;
}

async function buildCustomPlan(input, target, sections, environment) {
  const previous = readResponsesModelCatalog(environment, input.provider);
  const before = previous.definitions.find(entry => entry.id === input.model);
  if (!before || before.template?.source !== target.source || before.template.model !== target.sourceModel) {
    throw invalid("stale-preview", "model", "模型模板关联已变化，请重新对比");
  }
  const matches = (await loadResponsesModelTemplates(target.source, environment)).filter(entry => entry.id === target.sourceModel);
  if (matches.length !== 1) throw invalid("template-unavailable", "model", "源模板缺失或不唯一，未修改账户目录");
  const template = { ...completeDefinitionPrompts(matches)[0], maxContextWindow: matches[0].maxContextWindow ?? matches[0].contextWindow };
  const after = selectedFields(before, template, "custom", sections);
  if (after.contextWindow > (after.maxContextWindow ?? after.contextWindow)
    || (after.reasoningEfforts.length === 0 ? after.defaultReasoningEffort !== null : !after.reasoningEfforts.includes(after.defaultReasoningEffort))) {
    throw invalid("template-conflict", "model", "新模板不支持当前窗口或默认思考等级；请先单独调整本地设置");
  }
  const models = validateResponsesModels(previous.definitions.map(entry => entry.id === input.model ? after : entry), previous.defaultModel);
  const customInput = { provider: input.provider, model: previous.defaultModel, models };
  const customPreview = await previewCustomProviderModelsSave(customInput, { environment, expectedCatalogContent: previous.content });
  return { before, after: models.find(entry => entry.id === input.model), customInput, customPreview,
    previousContent: previous.content, sourceRevision: digest(template) };
}

async function buildManagedPlan(input, target, sections, environment) {
  const definition = loadManagedModelProviderDefinitions(environment).find(entry => entry.id === input.provider);
  if (definition?.storageId !== "deepseek") throw invalid("template-unavailable", "provider", "该账户没有明确的 DS 模板来源");
  const family = managedProviderAccountFamilies.find(entry => entry.storageId === definition.storageId);
  const directory = managedProviderDirectory(environment, definition);
  const catalogPath = join(directory, definition.catalogFileName);
  const manifestPath = join(directory, definition.catalogManifestFileName);
  const snapshots = snapshotProviderFiles([catalogPath, manifestPath, `${catalogPath}.backup`, `${manifestPath}.backup`,
    join(codexHomePath(environment), "config.toml"), join(codexHomePath(environment), definition.profileFileName),
    managedProviderMarkerPath(environment, definition), family.accountsFilePath(environment)], environment);
  const content = path => {
    const value = snapshots.find(snapshot => snapshot.path === path)?.content?.toString("utf8");
    if (value === undefined) throw invalid("provider-state-unavailable", "provider", "账户模型目录或来源清单缺失");
    return value;
  };
  let catalog, manifest;
  try { catalog = JSON.parse(content(catalogPath)); manifest = JSON.parse(content(manifestPath)); }
  catch { throw invalid("provider-state-unavailable", "provider", "账户目录或来源清单无法安全解析"); }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest) || typeof manifest.source !== "string" || !manifest.source) {
    throw invalid("provider-state-unavailable", "provider", "账户来源清单无效");
  }
  if (!Array.isArray(catalog?.models) || catalog.models.length === 0
    || catalog.models.some(model => !model || typeof model.slug !== "string")
    || new Set(catalog.models.map(model => model.slug)).size !== catalog.models.length) {
    throw invalid("provider-state-unavailable", "model", "账户模型目录成员缺失或重复，请先修复目录");
  }
  const source = normalizeDeepseekCatalogCapabilities(completeCatalogPrompts(JSON.parse(readFileSync(new URL("../runtime/model-catalog-deepseek.json", import.meta.url), "utf8"))));
  const matches = source.models.filter(entry => entry.slug === target.sourceModel);
  const before = catalog.models.find(entry => entry.slug === input.model);
  if (matches.length !== 1 || !before) throw invalid("template-unavailable", "model", "源模板或账户模型缺失，未修改账户目录");
  const template = { ...matches[0], max_context_window: matches[0].max_context_window ?? matches[0].context_window };
  const after = selectedFields(before, template, "managed", sections);
  if (after.context_window > (after.max_context_window ?? after.context_window)
    || !after.supported_reasoning_levels?.some(level => level.effort === after.default_reasoning_level)) {
    throw invalid("template-conflict", "model", "新模板不支持当前窗口或默认思考等级；请先单独调整本地设置");
  }
  const nextCatalog = { ...catalog, models: catalog.models.map(entry => entry.slug === input.model ? after : entry) };
  await validateModelCatalogWithCodex(nextCatalog, environment);
  const sourceRevision = digest(template);
  if (manifest.templateUpdates !== undefined && (!manifest.templateUpdates || typeof manifest.templateUpdates !== "object" || Array.isArray(manifest.templateUpdates))) {
    throw invalid("provider-state-unavailable", "provider", "账户模板更新来源记录无效");
  }
  const nextManifest = { ...manifest, templateUpdates: { ...manifest.templateUpdates,
    [input.model]: { source: "deepseek", model: target.sourceModel, revision: sourceRevision, sections } } };
  const updates = new Map([[`${catalogPath}.backup`, content(catalogPath)], [`${manifestPath}.backup`, content(manifestPath)],
    [catalogPath, `${JSON.stringify(nextCatalog, null, 2)}\n`], [manifestPath, `${JSON.stringify(nextManifest, null, 2)}\n`]]);
  await assertProviderFileSnapshots(snapshots);
  return { before, after, snapshots, updates, sourceRevision };
}

function invalid(code, field, message) {
  return new ProviderModelManagementError(code, field, message);
}
