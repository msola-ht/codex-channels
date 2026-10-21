import { createHash, createHmac, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { codexHomePath } from "../runtime/codex-home.mjs";
import { connectHomePath } from "../runtime/connect-home.mjs";
import { completeDefinitionPrompts } from "../runtime/model-template-catalog.mjs";
import { readModelTemplateBindings } from "../runtime/model-template-bindings.mjs";
import { loadManagedModelProviderDefinitions, managedProviderAccountFamilies } from "../runtime/model-provider-definitions.mjs";
import { managedProviderDirectory, managedProviderMarkerPath, writeManagedModelProviderCatalogUpdates,
  customPrimaryProviderProfilePath, customSwitchingProviderRegistryPath } from "../runtime/model-provider-runtime.mjs";
import { readResponsesModelCatalog, validateResponsesModels, responsesProviderCatalogPath, compileResponsesModelCatalog,
  writeResponsesModelCatalog, withResponsesModelCatalogWrite, finishResponsesModelCatalogWrite } from "../runtime/model-provider-responses-catalog.mjs";
import { customProviderUpstreamMetadataPath } from "../runtime/model-provider-upstream-metadata.mjs";
import { loadProviderModelCatalogs, ProviderModelManagementError } from "./provider-model-management.mjs";
import { loadResponsesModelTemplates } from "./responses-model-templates.mjs";
import { snapshotProviderFiles, assertProviderFileSnapshots } from "./managed-provider-files.mjs";
import { withModelProviderManagementTransaction } from "./model-provider-management-transaction.mjs";
import { validateModelCatalogWithCodex } from "./model-catalog-validation.mjs";
import { createDeepseekTemplateCatalog, createClinePassCatalogWithTemplateBindings } from "./provider-model-catalog.mjs";

const revisionSecret = randomBytes(32);
const sourceSnapshots = new Map();
const sourceLifetimeMs = 10 * 60 * 1000;
const maximumSnapshotBytes = 8 * 1024 * 1024;
const maximumCacheBytes = 32 * 1024 * 1024;
const maximumCacheEntries = 16;
const fields = {
  custom: {
    prompts: ["instructions", "modelMessages"],
    settings: ["effectiveContextWindowPercent", "autoCompactTokenLimit", "truncationPolicy"],
    capabilities: [],
  },
  managed: {
    prompts: ["base_instructions", "model_messages"],
    settings: ["effective_context_window_percent", "auto_compact_token_limit", "truncation_policy"],
    capabilities: ["description", "max_context_window", "supported_reasoning_levels", "input_modalities", "supports_image_detail_original", "support_verbosity", "default_verbosity", "supports_reasoning_summary_parameter", "default_reasoning_summary"],
  },
};
const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const authenticatedRevision = value => createHmac("sha256", revisionSecret).update(JSON.stringify(value)).digest("hex");

/** Fetch sources once; previews and writes consume this bounded process-local snapshot. */
export async function loadProviderModelTemplateOptions(provider, { environment = process.env, signal } = {}) {
  signal?.throwIfAborted();
  const state = await readTargetState(provider, environment);
  const templates = await loadSourceTemplates(state, environment, signal);
  const current = await readTargetState(provider, environment);
  signal?.throwIfAborted();
  if (current.revision !== state.revision) throw staleTarget();
  const snapshot = { provider, scope: state.scope, revision: state.revision, templates,
    expiresAt: Date.now() + sourceLifetimeMs, sourceRevision: digest(templates) };
  const bytes = Buffer.byteLength(JSON.stringify(snapshot));
  if (bytes > maximumSnapshotBytes) throw invalid("template-source-too-large", "template", "候选模板超过 8 MiB，请缩小源目录后重试");
  pruneSourceSnapshots();
  let totalBytes = [...sourceSnapshots.values()].reduce((total, entry) => total + entry.bytes, 0);
  while (sourceSnapshots.size >= maximumCacheEntries || totalBytes + bytes > maximumCacheBytes) {
    const oldest = sourceSnapshots.keys().next().value;
    totalBytes -= sourceSnapshots.get(oldest).bytes;
    sourceSnapshots.delete(oldest);
  }
  const sourceToken = randomBytes(32).toString("hex");
  sourceSnapshots.set(sourceToken, { ...snapshot, bytes });
  return { provider, revision: state.revision, sourceToken, expiresAt: snapshot.expiresAt, targets: state.targets,
    availableSections: Object.keys(fields[state.custom ? "custom" : "managed"]),
    templates: templates.map(({ source, model, displayName }) => ({ source, model, displayName })) };
}

export async function previewProviderModelTemplateUpdate(input, { environment = process.env } = {}) {
  return (await buildPlan(input, environment)).preview;
}

export async function applyProviderModelTemplateUpdate(input, { environment = process.env, preview } = {}) {
  return withModelProviderManagementTransaction(environment, async () => {
    const plan = await buildPlan(input, environment);
    if (!preview || preview.revision !== plan.preview.revision) throw invalid("stale-preview", "revision", "账户目录、候选模板或更新范围已变化，请重新对比");
    if (!plan.preview.willChange) return { action: "unchanged", activation: "none" };
    await assertProviderFileSnapshots(plan.snapshots);
    if (plan.customCatalog) {
      // Template updates cannot change connection selections. The catalog's
      // default may differ from the fixed config or switching profile default.
      try {
        const transaction = writeResponsesModelCatalog(environment, input.provider,
          plan.customCatalog.definitions, plan.customCatalog.defaultModel, plan.catalogRevision);
        await withResponsesModelCatalogWrite(transaction, async () => {
          if (readResponsesModelCatalog(environment, input.provider).content !== transaction.content) {
            throw new Error("模板目录回读不一致");
          }
          const written = new Set([transaction.path, `${transaction.path}.backup`, `${transaction.path}.pending`]);
          await assertProviderFileSnapshots(plan.snapshots.filter(snapshot => !written.has(snapshot.path)));
          finishResponsesModelCatalogWrite(transaction);
        });
      } catch (error) {
        throw invalid("readback-failed", "template", "模板目录保存未完成或结果无法确认；请核对目录、pending 与备份，勿自动重试", error);
      }
    } else {
      writeManagedModelProviderCatalogUpdates(input.provider, plan.updates,
        new Map(plan.snapshots.filter(snapshot => !snapshot.path.endsWith(".settings-pending"))
          .map(snapshot => [snapshot.path, snapshot.content?.toString("utf8")])), environment);
    }
    return { action: "updated", activation: plan.preview.activation };
  });
}

async function buildPlan(input, environment) {
  validateInput(input);
  pruneSourceSnapshots();
  const source = sourceSnapshots.get(input.sourceToken);
  if (!source || source.provider !== input.provider || source.scope !== environmentScope(environment)) {
    throw invalid("template-source-expired", "sourceToken", "候选模板已过期或不属于当前账户，请重新加载模板");
  }
  if (source.revision !== input.revision) throw staleTarget();
  const state = await readTargetState(input.provider, environment);
  if (state.revision !== input.revision) throw staleTarget();
  if (!state.targets.some(target => target.model === input.model)) throw invalid("template-unavailable", "model", "模型不在当前账户目录中");
  const matches = source.templates.filter(template => template.source === input.template.source && template.model === input.template.model);
  if (matches.length !== 1 || !allowedTemplate(state, input.model, input.template)) {
    throw invalid("template-unavailable", "template", "所选源模板不适用于当前账户模型，请明确选择可用模板");
  }
  const sections = ["prompts", "settings", "capabilities"].filter(section => input.sections.includes(section));
  const plan = state.custom
    ? await buildCustomPlan(input, matches[0], sections, state, environment)
    : await buildManagedPlan(input, matches[0], sections, state, environment);
  const changes = changedFields(plan.before, plan.after);
  if (!state.custom && !isDeepStrictEqual(Object.hasOwn(state.bindings, input.model) ? state.bindings[input.model] : null, input.template)) {
    changes.push({ field: "template", before: presence(state.bindings, input.model), after: { present: true, value: { ...input.template } } });
  }
  const preview = { provider: input.provider, model: input.model, source: input.template.source, sourceModel: input.template.model,
    sections, changes, willChange: changes.length > 0,
    activation: changes.length === 0 ? "none" : state.custom ? "restart-all" : "restart-app-server" };
  await assertProviderFileSnapshots(state.snapshots);
  // Codex validation may await; do not finish with an expired or evicted candidate.
  if (source.expiresAt <= Date.now() || sourceSnapshots.get(input.sourceToken) !== source) {
    throw invalid("template-source-expired", "sourceToken", "候选模板已过期，请重新加载模板");
  }
  const revision = authenticatedRevision({ preview, sourceToken: input.sourceToken, sourceRevision: source.sourceRevision,
    targetRevision: state.revision, scope: state.scope });
  return { ...plan, snapshots: state.snapshots, preview: { ...preview, revision } };
}

function validateInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)
    || Object.keys(input).some(key => !["provider", "model", "sections", "revision", "sourceToken", "template"].includes(key))
    || typeof input.provider !== "string" || typeof input.model !== "string"
    || typeof input.revision !== "string" || !/^[a-f0-9]{64}$/u.test(input.revision)
    || typeof input.sourceToken !== "string" || !/^[a-f0-9]{64}$/u.test(input.sourceToken)
    || !input.template || typeof input.template !== "object" || Array.isArray(input.template)
    || Object.keys(input.template).some(key => !["source", "model"].includes(key))
    || !["official", "deepseek", "cline"].includes(input.template.source)
    || typeof input.template.model !== "string" || !input.template.model
    || !Array.isArray(input.sections) || input.sections.length < 1 || input.sections.length > 3
    || new Set(input.sections).size !== input.sections.length
    || input.sections.some(section => !["prompts", "settings", "capabilities"].includes(section))) {
    throw invalid("invalid-input", "template", "请选择准确账户、模型、候选源模板与非空更新范围");
  }
}

function environmentScope(environment) {
  return JSON.stringify([codexHomePath(environment), connectHomePath(environment),
    resolve(environment.CODEX_CONNECT_CONFIG_FILE?.trim() || join(connectHomePath(environment), "config.toml"))]);
}

async function readTargetState(provider, environment) {
  if (typeof provider !== "string" || !provider || provider.length > 200) throw invalid("invalid-input", "provider", "请选择准确提供商账户");
  const { catalogs } = await loadProviderModelCatalogs({ environment });
  const visible = catalogs.find(entry => entry.providers.includes(provider));
  if (!visible) throw invalid("provider-not-configured", "provider", "提供商账户不存在或无法读取");
  const scope = environmentScope(environment);
  if (provider.startsWith("cp-")) {
    const previous = readResponsesModelCatalog(environment, provider);
    const path = responsesProviderCatalogPath(environment, provider);
    const snapshots = snapshotProviderFiles([path, `${path}.backup`, `${path}.pending`,
      join(codexHomePath(environment), "config.toml"), customPrimaryProviderProfilePath(environment, provider),
      customSwitchingProviderRegistryPath(environment), customProviderUpstreamMetadataPath(environment, provider)], environment);
    if (snapshotContent(snapshots, path) !== previous.content) throw staleTarget();
    assertVisibleModels(visible, previous.definitions.map(model => model.id));
    const targets = previous.definitions.map(entry => ({ model: entry.id, displayName: entry.name,
      template: entry.template ? { source: entry.template.source, model: entry.template.model } : null }));
    return { provider, custom: true, family: "custom", scope, previous, targets, snapshots,
      revision: targetRevision(provider, scope, visible, snapshots) };
  }
  const definition = loadManagedModelProviderDefinitions(environment).find(entry => entry.id === provider);
  const family = managedProviderAccountFamilies.find(entry => entry.storageId === definition?.storageId);
  if (!definition || !family) throw invalid("template-unavailable", "provider", "该提供商不支持账户模板更新");
  const directory = managedProviderDirectory(environment, definition);
  const members = loadManagedModelProviderDefinitions(environment).filter(entry => entry.storageId === definition.storageId);
  const catalogPath = join(directory, definition.catalogFileName);
  const manifestPath = join(directory, definition.catalogManifestFileName);
  const snapshots = snapshotProviderFiles([catalogPath, manifestPath, `${catalogPath}.backup`, `${manifestPath}.backup`,
    `${catalogPath}.settings-pending`, join(codexHomePath(environment), "config.toml"),
    ...members.flatMap(entry => [join(codexHomePath(environment), entry.profileFileName), managedProviderMarkerPath(environment, entry)]),
    family.accountsFilePath(environment)], environment);
  let catalog, manifest;
  try { catalog = JSON.parse(snapshotContent(snapshots, catalogPath)); manifest = JSON.parse(snapshotContent(snapshots, manifestPath)); }
  catch { throw invalid("provider-state-unavailable", "provider", "账户目录或来源清单无法安全解析"); }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest) || typeof manifest.source !== "string" || !manifest.source
    || !Array.isArray(catalog?.models) || catalog.models.length === 0
    || catalog.models.some(model => !model || typeof model.slug !== "string")
    || new Set(catalog.models.map(model => model.slug)).size !== catalog.models.length) {
    throw invalid("provider-state-unavailable", "provider", "账户目录或来源清单无效");
  }
  const ids = catalog.models.map(model => model.slug);
  assertVisibleModels(visible, ids);
  let bindings;
  try { bindings = readModelTemplateBindings(manifest, ids); }
  catch { throw invalid("provider-state-unavailable", "template", "账户模型模板关联无效，请先修复来源清单"); }
  const state = { provider, custom: false, family: family.storageId, scope, definition, catalogPath, manifestPath,
    catalog, manifest, bindings, snapshots, revision: targetRevision(provider, scope, visible, snapshots) };
  if (Object.entries(bindings).some(([model, template]) => !allowedTemplate(state, model, template))) {
    throw invalid("provider-state-unavailable", "template", "账户模型模板关联超出支持的来源或模型范围");
  }
  return { ...state, targets: visible.models.map(entry => ({ model: entry.id, displayName: entry.displayName,
    template: Object.hasOwn(bindings, entry.id) ? bindings[entry.id] : null })) };
}

function allowedTemplate(state, model, template) {
  if (state.custom) return ["official", "deepseek"].includes(template.source);
  if (state.family === "deepseek") return template.source === "deepseek" && template.model === model;
  if (state.family === "clp") return template.source === "cline" && template.model === model
    || template.source === "deepseek" && ["deepseek-flash", "deepseek-v4-pro"].includes(template.model);
  return ["ccg", "opencode-go"].includes(state.family) && template.source === "deepseek";
}

function assertVisibleModels(visible, ids) {
  if (!isDeepStrictEqual([...ids].sort(), visible.models.map(model => model.id).sort())) throw staleTarget();
}

function targetRevision(provider, scope, visible, snapshots) {
  return authenticatedRevision([provider, scope, visible, snapshots.map(snapshot => [snapshot.path, snapshot.content?.toString("base64") ?? null])]);
}

function snapshotContent(snapshots, path) {
  const value = snapshots.find(snapshot => snapshot.path === path)?.content?.toString("utf8");
  if (value === undefined) throw invalid("provider-state-unavailable", "provider", "账户模型目录或来源清单缺失");
  return value;
}

async function loadSourceTemplates(state, environment, signal) {
  let result;
  if (state.custom) {
    const sources = await Promise.all(["official", "deepseek"].map(async source =>
      completeDefinitionPrompts(await loadResponsesModelTemplates(source)).map(template => ({ source,
        model: template.id, displayName: template.name,
        template: { ...template, maxContextWindow: template.maxContextWindow ?? template.contextWindow } }))));
    result = sources.flat();
  } else if (state.family === "clp") {
    signal?.throwIfAborted();
    const { catalog, templateBindings } = createClinePassCatalogWithTemplateBindings(
      JSON.parse(readFileSync(new URL("../runtime/model-catalog-deepseek.json", import.meta.url), "utf8")));
    const seen = new Set();
    result = catalog.models.flatMap(template => {
      const binding = templateBindings[template.slug];
      if (seen.has(binding.model)) return [];
      seen.add(binding.model);
      return [{ ...binding, displayName: template.display_name,
        template: { ...template, max_context_window: template.max_context_window ?? template.context_window } }];
    });
  } else {
    const catalog = createDeepseekTemplateCatalog(
      JSON.parse(readFileSync(new URL("../runtime/model-catalog-deepseek.json", import.meta.url), "utf8")), state.family);
    result = catalog.models.map(template => ({ source: "deepseek", model: template.slug, displayName: template.display_name,
      template: { ...template, max_context_window: template.max_context_window ?? template.context_window } }));
  }
  if (!result.length || new Set(result.map(template => JSON.stringify([template.source, template.model]))).size !== result.length) {
    throw invalid("template-unavailable", "template", "源模板缺失或不唯一，未修改账户目录");
  }
  return JSON.parse(JSON.stringify(result));
}

function pruneSourceSnapshots() {
  const now = Date.now();
  for (const [token, snapshot] of sourceSnapshots) if (snapshot.expiresAt <= now) sourceSnapshots.delete(token);
}

function selectedFields(before, template, kind, sections) {
  const after = structuredClone(before);
  for (const field of sections.flatMap(section => fields[kind][section])) {
    if (Object.hasOwn(template, field)) after[field] = structuredClone(template[field]);
    else delete after[field];
  }
  return after;
}

function presence(record, field) {
  return Object.hasOwn(record, field) ? { present: true, value: structuredClone(record[field]) } : { present: false };
}

function changedFields(before, after) {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter(field => !isDeepStrictEqual(presence(before, field), presence(after, field)))
    .map(field => ({ field, before: presence(before, field), after: presence(after, field) }));
}

async function buildCustomPlan(input, source, sections, state, environment) {
  const previous = state.previous;
  const before = previous.definitions.find(entry => entry.id === input.model);
  const after = { ...selectedFields(before, source.template, "custom", sections), template: { ...input.template } };
  if (sections.includes("capabilities")) {
    after.experimentalSupportedTools = [...new Set([...(before.experimentalSupportedTools ?? []),
      ...(source.template.experimentalSupportedTools ?? []).filter(tool => ["send_user_message_async", "clock"].includes(tool))])];
  }
  if (after.contextWindow > (after.maxContextWindow ?? after.contextWindow)
    || ((after.reasoningEfforts?.length ?? 0) === 0 ? after.defaultReasoningEffort !== null : !after.reasoningEfforts.includes(after.defaultReasoningEffort))) {
    throw invalid("template-conflict", "model", "新模板不支持当前窗口或默认思考等级；请先单独调整本地设置");
  }
  validateTemplateSettings({
    context_window: after.contextWindow,
    effective_context_window_percent: after.effectiveContextWindowPercent,
    auto_compact_token_limit: after.autoCompactTokenLimit,
    truncation_policy: after.truncationPolicy,
  });
  const models = validateResponsesModels(previous.definitions.map(entry => entry.id === input.model ? after : entry), previous.defaultModel);
  const customCatalog = compileResponsesModelCatalog(models, previous.defaultModel);
  await validateModelCatalogWithCodex(customCatalog, environment);
  return { before, after: models.find(entry => entry.id === input.model), customCatalog, catalogRevision: previous.revision };
}

async function buildManagedPlan(input, source, sections, state, environment) {
  const { catalog, manifest, catalogPath, manifestPath } = state;
  const before = catalog.models.find(entry => entry.slug === input.model);
  const after = selectedFields(before, source.template, "managed", sections);
  if (sections.includes("capabilities")) {
    const existingTools = before.experimental_supported_tools === undefined ? [] : before.experimental_supported_tools;
    const sourceTools = source.template.experimental_supported_tools;
    if (!Array.isArray(existingTools) || existingTools.some(tool => typeof tool !== "string" || !tool.trim())
      || !Array.isArray(sourceTools) || sourceTools.some(tool => typeof tool !== "string" || !tool.trim())) {
      throw invalid("template-conflict", "experimental_supported_tools", "模型或来源的工具声明无效，请先检查目录");
    }
    // Only these local tools are template-managed; preserve every other declaration.
    after.experimental_supported_tools = [...new Set([...existingTools,
      ...sourceTools.filter(tool => tool === "send_user_message_async" || tool === "clock")])];
  }
  if (state.family === "clp" && sections.includes("capabilities")) {
    delete after.service_tiers;
  }
  if (after.context_window > (after.max_context_window ?? after.context_window)
    || (after.supported_reasoning_levels?.length === 0 ? after.default_reasoning_level !== null
      : !after.supported_reasoning_levels?.some(level => level.effort === after.default_reasoning_level))) {
    throw invalid("template-conflict", "model", "新模板不支持当前窗口或默认思考等级；请先单独调整本地设置");
  }
  // Only imported settings need the template conflict check. Existing managed
  // compaction thresholds are preserved and Codex clamps them to the window.
  if (sections.includes("settings")) validateTemplateSettings(after);
  const nextCatalog = { ...catalog, models: catalog.models.map(entry => entry.slug === input.model ? after : entry) };
  await validateModelCatalogWithCodex(nextCatalog, environment);
  if (manifest.templateUpdates !== undefined && (!manifest.templateUpdates || typeof manifest.templateUpdates !== "object" || Array.isArray(manifest.templateUpdates))) {
    throw invalid("provider-state-unavailable", "provider", "账户模板更新来源记录无效");
  }
  const nextManifest = { ...manifest, modelTemplates: { ...state.bindings, [input.model]: { ...input.template } },
    templateUpdates: { ...manifest.templateUpdates,
      [input.model]: { source: input.template.source, model: input.template.model, revision: digest(source.template), sections } } };
  const updates = new Map([[`${catalogPath}.backup`, snapshotContent(state.snapshots, catalogPath)],
    [`${manifestPath}.backup`, snapshotContent(state.snapshots, manifestPath)],
    [catalogPath, `${JSON.stringify(nextCatalog, null, 2)}\n`], [manifestPath, `${JSON.stringify(nextManifest, null, 2)}\n`]]);
  return { before, after, updates };
}

function validateTemplateSettings(model) {
  const percent = model.effective_context_window_percent;
  if (percent !== undefined && (!Number.isSafeInteger(percent) || percent < 1 || percent > 100)) {
    throw invalid("template-conflict", "effective_context_window_percent", "模板有效上下文百分比必须为 1-100 的整数");
  }
  const compact = model.auto_compact_token_limit;
  if (compact != null && (!Number.isSafeInteger(compact) || compact < 1 || compact > Math.floor(model.context_window * 9 / 10))) {
    throw invalid("template-conflict", "auto_compact_token_limit", "模板自动压缩阈值必须为正整数且不能超过当前上下文窗口的 90%；请先调整本地窗口或缩小更新范围");
  }
  const truncation = model.truncation_policy;
  if (truncation !== undefined && (!truncation || typeof truncation !== "object" || Array.isArray(truncation)
    || Object.keys(truncation).some(key => !["mode", "limit"].includes(key)) || !["tokens", "bytes"].includes(truncation.mode)
    || !Number.isSafeInteger(truncation.limit) || truncation.limit < 1)) {
    throw invalid("template-conflict", "truncation_policy", "模板截断策略必须使用 tokens 或 bytes，limit 必须为正安全整数");
  }
}

function staleTarget() {
  return invalid("stale-preview", "revision", "账户目录或模板关联已变化，请重新加载候选模板并对比");
}

function invalid(code, field, message, cause) {
  return new ProviderModelManagementError(code, field, message, cause === undefined ? undefined : { cause });
}
