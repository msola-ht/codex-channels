import { createHmac, randomBytes } from "node:crypto";
import { join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { codexHomePath } from "../runtime/codex-home.mjs";
import { connectHomePath } from "../runtime/connect-home.mjs";
import { loadManagedModelProviderDefinitions, managedProviderAccountFamilies, isManagedProviderModelValid } from "../runtime/model-provider-definitions.mjs";
import { managedProviderDirectory, managedProviderMarkerPath, writeManagedModelProviderCatalogUpdates } from "../runtime/model-provider-runtime.mjs";
import { modelDefinitionsFromCatalog, compileModelDefinitions, validateModelDefinitions } from "../runtime/model-catalog.mjs";
import { modelCatalogSetting } from "../runtime/managed-model-catalog.mjs";
import { readModelTemplateBindings } from "../runtime/model-template-bindings.mjs";
import { loadProviderModelCatalogs, ProviderModelManagementError } from "./provider-model-management.mjs";
import { snapshotProviderFiles, assertProviderFileSnapshots } from "./managed-provider-files.mjs";
import { withModelProviderManagementTransaction } from "./model-provider-management-transaction.mjs";
import { validateModelCatalogWithCodex } from "./model-catalog-validation.mjs";

const revisionSecret = randomBytes(32);
const revisionOf = value => createHmac("sha256", revisionSecret).update(JSON.stringify(value)).digest("hex");
const fields = new Set(["id", "name", "description", "contextWindow", "maxContextWindow", "reasoningEfforts",
  "defaultReasoningEffort", "reasoningDescriptions", "supportsImages", "applyPatchToolType", "supportsSearchTool",
  "supportsImageDetailOriginal", "supportsVerbosity", "defaultVerbosity", "supportsReasoningSummary", "defaultReasoningSummary",
  "instructions", "modelMessages", "experimentalSupportedTools", "supportsWebSearch", "effectiveContextWindowPercent", "autoCompactTokenLimit", "truncationPolicy"]);

/** Read only the saved model; no source lookup or template completion occurs. */
export async function loadManagedProviderModelEdit(provider, model, { environment = process.env } = {}) {
  try {
    const state = await readState(provider, model, environment);
    return { provider, model, providers: state.providers, revision: state.revision, definition: state.definition };
  } catch (error) { throw stateError(error); }
}

export async function previewManagedProviderModelEdit(input, { environment = process.env } = {}) {
  try { return (await buildPlan(input, environment, true)).preview; }
  catch (error) { throw stateError(error); }
}

export async function applyManagedProviderModelEdit(input, { environment = process.env, preview } = {}) {
  try {
    return await withModelProviderManagementTransaction(environment, async () => {
      const plan = await buildPlan(input, environment, false);
      if (!preview || !isDeepStrictEqual(preview, plan.preview)) throw stale();
      if (!plan.preview.willChange) return { action: "unchanged", activation: "none" };
      await assertProviderFileSnapshots(plan.state.snapshots).catch(() => { throw stale(); });
      try {
        writeManagedModelProviderCatalogUpdates(input.provider, plan.updates,
          new Map(plan.state.snapshots.filter(file => !file.path.endsWith(".settings-pending"))
            .map(file => [file.path, file.content?.toString("utf8")])), environment);
      } catch (error) {
        throw invalid("operation-failed", "definition", "模型保存未完成或结果无法确认；请核对目录、备份及恢复记录，勿自动重试", error);
      }
      return { action: "updated", activation: plan.preview.activation };
    });
  } catch (error) { throw stateError(error); }
}

async function buildPlan(input, environment, validateCatalog) {
  if (!record(input) || Object.keys(input).some(key => !["provider", "model", "revision", "definition"].includes(key))
    || typeof input.revision !== "string" || !/^[a-f0-9]{64}$/u.test(input.revision)) {
    throw invalid("invalid-input", "revision", "请提供准确账户、原模型 ID、完整模型定义及有效目录修订");
  }
  const state = await readState(input.provider, input.model, environment);
  if (input.revision !== state.revision) throw stale();
  if (!record(input.definition) || Object.keys(input.definition).some(key => !fields.has(key))
    || input.definition.id !== input.model) {
    throw invalid("invalid-input", "definition", "仅可编辑已保存模型的支持字段；模型 ID、请求路由及模板关联不能修改");
  }
  for (const field of ["experimentalSupportedTools", "supportsWebSearch"]) {
    if (!isDeepStrictEqual(presence(input.definition, field), presence(state.definition, field))) {
      throw invalid("invalid-input", field, "已有本地工具声明及历史网页搜索元数据只允许保留，不能在此入口修改");
    }
  }
  if (input.definition.supportsImageDetailOriginal === true
    || input.definition.supportsReasoningSummary === true
    || input.definition.defaultReasoningSummary !== undefined && input.definition.defaultReasoningSummary !== "none") {
    throw invalid("invalid-input", "definition", "CLP Chat 桥不支持 original 图片细节或思考摘要控制，摘要只能关闭为 none");
  }
  if (!Array.isArray(input.definition.reasoningEfforts) || input.definition.reasoningEfforts.length === 0) {
    throw invalid("invalid-input", "reasoningEfforts", "受管模型必须声明非空思考等级；不支持思考时仅选 none");
  }
  let definition;
  try { [definition] = validateModelDefinitions([input.definition], input.model, { allowReasoningToggle: true }); }
  catch (error) { throw invalid("invalid-input", "definition", "模型名称、窗口、思考等级、提示词或能力定义无效", error); }
  const oldCompiled = compileModelDefinitions([state.definition], input.model, { allowReasoningToggle: true }).models[0];
  const newCompiled = compileModelDefinitions([definition], input.model, { allowReasoningToggle: true }).models[0];
  const after = { ...state.original };
  // Apply compilation differences to this raw model only. Compiler defaults must
  // not rewrite saved metadata, routes, other models, or an untouched field.
  for (const field of new Set([...Object.keys(oldCompiled), ...Object.keys(newCompiled)])) {
    if (isDeepStrictEqual(presence(oldCompiled, field), presence(newCompiled, field))) continue;
    if (Object.hasOwn(newCompiled, field)) after[field] = newCompiled[field];
    else delete after[field];
  }
  if (after.slug !== state.original.slug || !isDeepStrictEqual(presence(after, "cline_request_profile"), presence(state.original, "cline_request_profile"))) {
    throw invalid("invalid-input", "definition", "模型编辑不能改变模型身份或请求路由");
  }
  const changes = [...new Set([...Object.keys(state.original), ...Object.keys(after)])].sort()
    .filter(field => !isDeepStrictEqual(presence(state.original, field), presence(after, field)))
    .map(field => ({ field, before: presence(state.original, field), after: presence(after, field) }));
  const catalog = { ...state.catalog, models: state.catalog.models.map(model => model.slug === input.model ? after : model) };
  // Validate the managed catalog contract separately from Codex's decoder: a
  // successful decoder alone does not establish a consumable managed default.
  for (const model of catalog.models) modelCatalogSetting(JSON.stringify(catalog), state.providerDefinition, model.slug);
  if (validateCatalog && changes.length) {
    try { await validateModelCatalogWithCodex(catalog, environment); }
    catch (error) { throw invalid("invalid-input", "definition", "模型目录未通过当前 Codex CLI 校验；原目录未修改", error); }
  }
  await assertProviderFileSnapshots(state.snapshots).catch(() => { throw stale(); });
  const preview = { provider: input.provider, model: input.model, providers: state.providers,
    revision: revisionOf([state.revision, definition, changes]), changes,
    willChange: changes.length > 0, activation: changes.length ? "restart-app-server" : "none" };
  return { state, preview, updates: new Map([
    [`${state.catalogPath}.backup`, content(state.snapshots, state.catalogPath)],
    [`${state.manifestPath}.backup`, content(state.snapshots, state.manifestPath)],
    [state.catalogPath, `${JSON.stringify(catalog, null, 2)}\n`],
    [state.manifestPath, content(state.snapshots, state.manifestPath)],
  ]) };
}

async function readState(provider, model, environment) {
  if (typeof provider !== "string" || !provider || provider.length > 200
    || typeof model !== "string" || !model || model.length > 200) {
    throw invalid("invalid-input", "provider", "请选择准确的已配置 CLP 账户和已有模型 ID");
  }
  const definitions = loadManagedModelProviderDefinitions(environment);
  const providerDefinition = definitions.find(entry => entry.id === provider);
  const family = managedProviderAccountFamilies.find(entry => entry.storageId === providerDefinition?.storageId);
  if (!providerDefinition || family?.storageId !== "clp") throw invalid("edit-unavailable", "provider", "本地模型编辑仅支持已配置 CLP 账户");
  if (!isManagedProviderModelValid(providerDefinition, model)) throw invalid("invalid-input", "model", "CLP 模型 ID 无效");
  const { catalogs } = await loadProviderModelCatalogs({ environment });
  const visible = catalogs.find(catalog => catalog.providers.includes(provider));
  if (!visible) throw invalid("provider-not-configured", "provider", "提供商账户不存在或模型目录不可用");
  const members = definitions.filter(entry => entry.storageId === providerDefinition.storageId);
  if (!isDeepStrictEqual(members.map(entry => entry.id).sort(), [...visible.providers].sort())) {
    throw invalid("provider-state-unavailable", "provider", "同族账户配置不完整，无法安全编辑共享模型目录");
  }
  const directory = managedProviderDirectory(environment, providerDefinition);
  const catalogPath = join(directory, providerDefinition.catalogFileName);
  const manifestPath = join(directory, providerDefinition.catalogManifestFileName);
  const snapshots = snapshotProviderFiles([catalogPath, manifestPath, `${catalogPath}.backup`, `${manifestPath}.backup`, `${catalogPath}.settings-pending`,
    join(codexHomePath(environment), "config.toml"), family.accountsFilePath(environment),
    ...members.flatMap(entry => [managedProviderMarkerPath(environment, entry), join(codexHomePath(environment), entry.profileFileName)])], environment);
  if (snapshots.find(file => file.path === `${catalogPath}.settings-pending`).content !== undefined) {
    throw invalid("provider-state-unavailable", "provider", "共享模型目录存在未完成设置事务，请先使用提供商恢复入口处理");
  }
  let catalog, manifest;
  try { catalog = JSON.parse(content(snapshots, catalogPath)); manifest = JSON.parse(content(snapshots, manifestPath)); }
  catch (error) { throw invalid("provider-state-unavailable", "provider", "账户模型目录或来源清单无法安全解析", error); }
  if (!record(catalog) || !Array.isArray(catalog.models) || !catalog.models.length
    || catalog.models.some(model => !record(model) || !isManagedProviderModelValid(providerDefinition, model.slug))
    || new Set(catalog.models.map(model => model.slug)).size !== catalog.models.length
    || !record(manifest) || typeof manifest.source !== "string" || !manifest.source) {
    throw invalid("provider-state-unavailable", "provider", "账户模型目录或来源清单无效");
  }
  readModelTemplateBindings(manifest, catalog.models.map(model => model.slug));
  if (!isDeepStrictEqual(catalog.models.map(model => model.slug).sort(), visible.models.map(model => model.id).sort())) throw stale();
  const original = catalog.models.find(entry => entry.slug === model);
  if (!original) throw invalid("invalid-input", "model", "模型不在该 CLP 账户当前保存目录中");
  let definition;
  try {
    // Project only the selected model. Other managed entries are not constrained
    // by the editable definition schema and remain byte-for-byte JSON values.
    [definition] = modelDefinitionsFromCatalog({ models: [original] }, "official", { allowReasoningToggle: true });
    if (!definition) throw new Error("模型未声明可见且可用于 API");
    delete definition.template;
    // Unlike template import, editing a saved model retains historical metadata
    // in the full definition without making it an editable capability.
    if (Object.hasOwn(original, "supports_web_search")) definition.supportsWebSearch = original.supports_web_search;
    [definition] = validateModelDefinitions([definition], model, { allowReasoningToggle: true });
  } catch (error) { throw invalid("provider-state-unavailable", "definition", "已保存模型无法投影为可编辑定义，请核对模型字段", error); }
  await assertProviderFileSnapshots(snapshots).catch(() => { throw stale(); });
  const scope = [codexHomePath(environment), connectHomePath(environment), resolve(environment.CODEX_CONNECT_CONFIG_FILE?.trim() || join(connectHomePath(environment), "config.toml"))];
  const revision = revisionOf([provider, model, scope, visible, snapshots.map(file => [file.path, file.content?.toString("base64") ?? null])]);
  return { providerDefinition, providers: visible.providers, definition, original, catalog, catalogPath, manifestPath, snapshots, revision };
}

function record(value) { return value !== null && typeof value === "object" && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value)); }
function presence(value, field) { return Object.hasOwn(value, field) ? { present: true, value: value[field] } : { present: false }; }
function content(files, path) {
  const value = files.find(file => file.path === path)?.content?.toString("utf8");
  if (value === undefined) throw invalid("provider-state-unavailable", "provider", "账户模型目录或来源清单缺失");
  return value;
}
function invalid(code, field, message, cause) { return new ProviderModelManagementError(code, field, message, cause === undefined ? undefined : { cause }); }
function stale() { return invalid("stale-preview", "revision", "模型目录、来源或相关账户配置已变化，请重新加载并预览"); }
function stateError(error) { return error instanceof ProviderModelManagementError ? error : invalid("provider-state-unavailable", "provider", "无法安全读取或生成本地模型编辑计划", error); }
