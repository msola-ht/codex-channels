import { createHmac, randomBytes } from "node:crypto";
import { join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { codexHomePath } from "../runtime/codex-home.mjs";
import { connectHomePath } from "../runtime/connect-home.mjs";
import { loadManagedModelProviderDefinitions, managedProviderAccountFamilies, isManagedProviderModelValid } from "../runtime/model-provider-definitions.mjs";
import { managedProviderDirectory, managedProviderMarkerPath, withManagedModelCatalogSettings, writeManagedModelProviderCatalogUpdates } from "../runtime/model-provider-runtime.mjs";
import { createResponsesModelCatalog } from "../runtime/model-provider-responses-catalog.mjs";
import { thirdPartyCodingInstructions } from "../runtime/third-party-coding-instructions.mjs";
import { withThirdPartyLocalTools } from "../runtime/third-party-model-catalog.mjs";
import { resolveClinePassRequestProfile } from "../runtime/chat-reasoning.mjs";
import { readModelTemplateBindings } from "../runtime/model-template-bindings.mjs";
import { downloadClineRelayCatalog } from "../runtime/cline-relay-catalog-update.mjs";
import { loadProviderModelCatalogs, ProviderModelManagementError } from "./provider-model-management.mjs";
import { downloadDeepseekCatalog } from "./deepseek-setup.mjs";
import { createCcgCatalogWithTemplateBindings, createOpencodeGoCatalogWithTemplateBindings } from "./provider-model-catalog.mjs";
import { createClinePassCatalog, projectClinePassModels } from "./cline-pass-account-management.mjs";
import { loadResponsesModelTemplates } from "./responses-model-templates.mjs";
import { snapshotProviderFiles, assertProviderFileSnapshots } from "./managed-provider-files.mjs";
import { withModelProviderManagementTransaction } from "./model-provider-management-transaction.mjs";
import { validateModelCatalogWithCodex } from "./model-catalog-validation.mjs";

const secret = randomBytes(32);
const snapshots = new Map();
const lifetimeMs = 10 * 60 * 1000;
const maximumSnapshotBytes = 4 * 1024 * 1024;
const maximumCacheBytes = 16 * 1024 * 1024;
const maximumCandidates = 128;
const revisionOf = value => createHmac("sha256", secret).update(JSON.stringify(value)).digest("hex");
const invalid = (code, field, message, cause) => new ProviderModelManagementError(code, field, message, cause ? { cause } : undefined);
const stale = () => invalid("stale-preview", "revision", "账户目录、来源或选择范围已变化，请重新读取新增候选并预览");
const stateError = error => error instanceof ProviderModelManagementError || error?.name === "AbortError" || error?.name === "TimeoutError"
  ? error : invalid("provider-state-unavailable", "provider", "无法安全读取或生成新增模型计划；原目录未修改", error);

/** The downloaded source is retained privately; callers select exact candidate IDs only. */
export async function loadProviderModelAdditionOptions(provider, {
  environment = process.env, signal, manualModel,
  downloadCatalog = downloadDeepseekCatalog, downloadClineCatalog = downloadClineRelayCatalog, loadTemplates = loadResponsesModelTemplates,
} = {}) {
  try {
    const deadline = globalThis.AbortSignal.timeout(90_000);
    const operationSignal = signal ? globalThis.AbortSignal.any([signal, deadline]) : deadline;
    operationSignal.throwIfAborted();
    const state = await readState(provider, environment);
    let models, bindings = {}, source;
    if (manualModel && typeof manualModel === "object" && Object.hasOwn(manualModel, "inheritFrom")) {
      if (state.family.storageId !== "clp" || Array.isArray(manualModel)
        || Object.keys(manualModel).some(key => !["id", "name", "inheritFrom"].includes(key))
        || !isManagedProviderModelValid(state.definition, manualModel.id)
        || !isManagedProviderModelValid(state.definition, manualModel.inheritFrom)
        || typeof manualModel.name !== "string" || !manualModel.name.trim() || manualModel.name.length > 120 || /\p{Cc}/u.test(manualModel.name)) {
        throw invalid("invalid-input", "manualModel", "继承仅支持同一 CLP 目录的已有模型；请提供有效的新 ID、名称及来源，不混入独立能力字段");
      }
      if (state.catalog.models.some(model => model.slug === manualModel.id)) throw invalid("model-exists", "manualModel", "模型 ID 已存在，新增不能覆盖已有模型");
      const original = state.catalog.models.find(model => model.slug === manualModel.inheritFrom);
      if (!original) throw invalid("invalid-input", "manualModel", "继承来源不在当前 CLP 目录中，请重新选择");
      const profile = resolveClinePassRequestProfile(original.slug, original.cline_request_profile);
      models = [{ ...structuredClone(original), slug: manualModel.id, display_name: manualModel.name.trim(), cline_request_profile: profile }];
      source = { kind: "inherited", model: original.slug, clineRequestProfile: profile };
    } else if (manualModel !== undefined) {
      if (manualModel && typeof manualModel === "object" && Object.hasOwn(manualModel, "sampling")) {
        throw invalid("invalid-input", "manualModel", "受管模型手动新增不支持默认采样参数；sampling 不会保存，请移除此字段");
      }
      if (!["ccg", "opencode-go", "clp"].includes(state.family.storageId)
        || !manualModel || typeof manualModel !== "object" || Array.isArray(manualModel)
        || !Array.isArray(manualModel.reasoningEfforts) || manualModel.reasoningEfforts.length === 0
        || typeof manualModel.supportsImages !== "boolean" || typeof manualModel.supportsSearchTool !== "boolean"
        || ![null, "freeform"].includes(manualModel.applyPatchToolType) || manualModel.template !== undefined) {
        throw invalid("invalid-input", "manualModel", "手动新增仅支持 CCG／OCG／CLP；须明确声明思考等级、图片、apply_patch 和 tool_search 能力，不自动关联模板");
      }
      const clinePass = state.family.storageId === "clp";
      if (clinePass && manualModel.supportsImageDetailOriginal !== undefined && manualModel.supportsImageDetailOriginal !== false) {
        throw invalid("invalid-input", "manualModel", "CLP Chat 桥不支持 original 图片细节");
      }
      if (clinePass && (manualModel.supportsReasoningSummary === true
        || manualModel.defaultReasoningSummary !== undefined && manualModel.defaultReasoningSummary !== "none")) {
        throw invalid("invalid-input", "manualModel", "CLP Chat 桥不支持思考摘要控制");
      }
      try {
        const catalog = createResponsesModelCatalog([{ ...manualModel, instructions: manualModel.instructions ?? thirdPartyCodingInstructions,
          ...(clinePass ? { supportsImageDetailOriginal: false } : {}),
        }], manualModel.id, { allowReasoningToggle: clinePass });
        models = (clinePass ? withThirdPartyLocalTools(catalog) : catalog).models;
        validateModel(models[0], state.definition);
      } catch (error) {
        throw invalid("invalid-input", "manualModel", "手动模型 ID、上下文、默认思考等级或能力定义无效", error);
      }
      if (state.catalog.models.some(model => model.slug === manualModel.id)) throw invalid("model-exists", "manualModel", "模型 ID 已存在，新增不能覆盖已有模型");
      source = { kind: "manual" };
    } else if (state.family.storageId === "clp") {
      const downloaded = await downloadClineCatalog(environment, operationSignal);
      operationSignal.throwIfAborted();
      const projected = projectClinePassModels(downloaded, { requireModels: false });
      const candidates = projected.models.filter(model => !state.catalog.models.some(saved => saved.slug === model.id));
      if (candidates.length > maximumCandidates) throw invalid("addition-source-too-large", "models", "新增候选超过 128 个，请缩小源目录后重试");
      const templates = candidates.some(model => model.id === state.definition.defaultModel) ? await loadTemplates("deepseek") : [];
      models = candidates.flatMap(model => createClinePassCatalog(templates, downloaded, [model.id]).models);
      bindings = Object.fromEntries(models.map(model => [model.slug, { source: "cline", model: model.slug }]));
      source = { kind: "cline", commit: downloaded.commit, downloadedAt: downloaded.downloadedAt };
    } else {
      const downloaded = await downloadCatalog(globalThis.fetch, { signal: operationSignal });
      operationSignal.throwIfAborted();
      const generated = (state.family.storageId === "ccg" ? createCcgCatalogWithTemplateBindings : createOpencodeGoCatalogWithTemplateBindings)(downloaded.catalog);
      models = generated.catalog.models;
      bindings = generated.templateBindings;
      source = { kind: "deepseek", sha256: downloaded.sha256 };
    }
    operationSignal.throwIfAborted();
    if (!Array.isArray(models) || models.some(model => !model || typeof model.slug !== "string")
      || new Set(models.map(model => model.slug)).size !== models.length) throw invalid("addition-source-invalid", "models", "新增来源包含无效或重复的模型 ID");
    const candidates = models.filter(model => !state.catalog.models.some(saved => saved.slug === model.slug)).map(model => {
      validateModel(model, state.definition);
      return { model: model.slug, displayName: model.display_name ?? model.slug, fields: model,
        ...(source.kind === "inherited" ? { inheritedFrom: source.model, clineRequestProfile: source.clineRequestProfile } : {}),
        ...(Object.hasOwn(bindings, model.slug) ? { template: bindings[model.slug] } : {}) };
    });
    if (candidates.length > maximumCandidates) throw invalid("addition-source-too-large", "models", "新增候选超过 128 个，请缩小源目录后重试");
    const current = await readState(provider, environment);
    if (current.revision !== state.revision) throw stale();
    operationSignal.throwIfAborted();
    const snapshot = { provider, providers: state.providers, scope: state.scope, revision: state.revision, source,
      candidates, expiresAt: Date.now() + lifetimeMs };
    const bytes = Buffer.byteLength(JSON.stringify(snapshot));
    if (bytes > maximumSnapshotBytes) throw invalid("addition-source-too-large", "models", "新增候选超过 4 MiB，请缩小源目录后重试");
    for (const [token, entry] of snapshots) if (entry.expiresAt <= Date.now()) snapshots.delete(token);
    let total = [...snapshots.values()].reduce((sum, entry) => sum + entry.bytes, 0);
    while (snapshots.size >= 16 || total + bytes > maximumCacheBytes) {
      const first = snapshots.keys().next().value;
      total -= snapshots.get(first).bytes;
      snapshots.delete(first);
    }
    const sourceToken = randomBytes(32).toString("hex");
    snapshots.set(sourceToken, { ...structuredClone(snapshot), bytes });
    return structuredClone({ provider, sourceToken, revision: snapshot.revision, expiresAt: snapshot.expiresAt, providers: snapshot.providers, candidates });
  } catch (error) { throw stateError(error); }
}

export async function previewProviderModelAddition(input, { environment = process.env } = {}) {
  try { return (await buildPlan(input, environment, true)).preview; }
  catch (error) { throw stateError(error); }
}

export async function applyProviderModelAddition(input, { environment = process.env, preview } = {}) {
  return withModelProviderManagementTransaction(environment, async () => {
    let plan;
    try { plan = await buildPlan(input, environment, false); }
    catch (error) { throw stateError(error); }
    if (!preview || !isDeepStrictEqual(preview, plan.preview)) throw stale();
    if (!plan.preview.willChange) return { action: "unchanged", activation: "none", models: plan.models };
    await assertProviderFileSnapshots(plan.state.snapshots).catch(() => { throw stale(); });
    const snapshot = snapshots.get(input.sourceToken);
    if (!snapshot || snapshot.expiresAt <= Date.now()) throw invalid("addition-source-expired", "sourceToken", "新增候选已过期，请重新读取并预览");
    try {
      writeManagedModelProviderCatalogUpdates(input.provider, plan.updates,
        new Map(plan.state.snapshots.filter(snapshot => !snapshot.path.endsWith(".settings-pending"))
          .map(snapshot => [snapshot.path, snapshot.content?.toString("utf8")])), environment);
    } catch (error) {
      throw invalid("operation-failed", "models", "新增模型保存未完成；请核对原目录、备份与恢复记录，勿自动重试", error);
    }
    snapshots.delete(input.sourceToken);
    return { action: "catalog-updated", activation: "restart-all", models: plan.models };
  });
}

async function buildPlan(input, environment, validate) {
  if (!input || typeof input !== "object" || Array.isArray(input)
    || Object.keys(input).some(key => !["provider", "sourceToken", "revision", "models"].includes(key))
    || typeof input.provider !== "string" || typeof input.sourceToken !== "string" || !/^[a-f0-9]{64}$/u.test(input.sourceToken)
    || typeof input.revision !== "string" || !/^[a-f0-9]{64}$/u.test(input.revision)
    || !Array.isArray(input.models) || input.models.length > 64 || new Set(input.models).size !== input.models.length
    || input.models.some(model => typeof model !== "string" || !model || model.length > 200)) {
    throw invalid("invalid-input", "models", "请选择准确账户、有效候选修订和不重复的新增模型 ID");
  }
  const snapshot = snapshots.get(input.sourceToken);
  if (!snapshot || snapshot.expiresAt <= Date.now()) throw invalid("addition-source-expired", "sourceToken", "新增候选已过期，请重新读取并预览");
  const state = await readState(input.provider, environment);
  if (snapshot.provider !== input.provider || snapshot.scope !== state.scope || snapshot.revision !== state.revision
    || input.revision !== snapshot.revision) throw stale();
  const additions = snapshot.candidates.filter(candidate => input.models.includes(candidate.model));
  if (additions.length !== input.models.length || additions.some(candidate => state.catalog.models.some(model => model.slug === candidate.model))) {
    throw invalid("addition-unavailable", "models", "所选模型不在当前新增候选中，或 ID 已存在");
  }
  if (additions.length && state.catalog.models.length + additions.length > 64) throw invalid("invalid-input", "models", "保存后的模型目录最多允许 64 个模型");
  const catalog = { ...state.catalog, models: [...state.catalog.models, ...additions.map(candidate => candidate.fields)] };
  const bindings = { ...state.bindings, ...Object.fromEntries(additions.filter(candidate => candidate.template).map(candidate => [candidate.model, candidate.template])) };
  const manifest = { ...state.manifest,
    ...(state.manifest.modelTemplates !== undefined || Object.keys(bindings).length ? { modelTemplates: bindings } : {}),
    ...(state.family.storageId === "clp" && additions.length ? {
      ...(additions.some(model => model.model === state.definition.defaultModel) ? { source: "deepseek", model: "deepseek-flash" } : {}),
    } : {}),
  };
  if (validate && additions.length) await validateModelCatalogWithCodex(catalog, environment);
  await assertProviderFileSnapshots(state.snapshots);
  if (snapshot.expiresAt <= Date.now() || snapshots.get(input.sourceToken) !== snapshot) throw invalid("addition-source-expired", "sourceToken", "新增候选已过期，请重新读取并预览");
  const preview = { provider: input.provider, providers: state.providers, additions: structuredClone(additions),
    revision: revisionOf([state.revision, input.sourceToken, snapshot.source, additions]),
    willChange: additions.length > 0, activation: additions.length ? "restart-all" : "none" };
  return { state, preview, models: catalog.models.map(model => model.slug), updates: new Map([
    [`${state.catalogPath}.backup`, content(state.snapshots, state.catalogPath)],
    [`${state.manifestPath}.backup`, content(state.snapshots, state.manifestPath)],
    [state.catalogPath, `${JSON.stringify(catalog, null, 2)}\n`], [state.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`],
  ]) };
}

async function readState(provider, environment) {
  if (typeof provider !== "string" || !provider || provider.length > 200) throw invalid("invalid-input", "provider", "请选择准确提供商账户");
  const definitions = loadManagedModelProviderDefinitions(environment);
  const definition = definitions.find(entry => entry.id === provider);
  const family = managedProviderAccountFamilies.find(entry => entry.storageId === definition?.storageId);
  if (!definition || !family || !["ccg", "opencode-go", "clp"].includes(family.storageId)) throw invalid("addition-unavailable", "provider", "新增仅支持已配置的 CCG、OCG 或 CLP 账户");
  const { catalogs } = await loadProviderModelCatalogs({ environment });
  const visible = catalogs.find(catalog => catalog.providers.includes(provider));
  if (!visible) throw invalid("provider-not-configured", "provider", "提供商账户不存在或目录不可用");
  const members = definitions.filter(entry => entry.storageId === definition.storageId);
  if (!isDeepStrictEqual(members.map(entry => entry.id).sort(), [...visible.providers].sort())) throw invalid("provider-state-unavailable", "provider", "同族账户配置不完整，未更新模型目录");
  const directory = managedProviderDirectory(environment, definition);
  const catalogPath = join(directory, definition.catalogFileName);
  const manifestPath = join(directory, definition.catalogManifestFileName);
  const files = snapshotProviderFiles([catalogPath, manifestPath, `${catalogPath}.backup`, `${manifestPath}.backup`, `${catalogPath}.settings-pending`,
    join(codexHomePath(environment), "config.toml"), family.accountsFilePath(environment),
    ...members.flatMap(entry => [managedProviderMarkerPath(environment, entry), join(codexHomePath(environment), entry.profileFileName)])], environment);
  let catalog, manifest;
  try { catalog = JSON.parse(content(files, catalogPath)); manifest = JSON.parse(content(files, manifestPath)); }
  catch (error) { throw invalid("provider-state-unavailable", "provider", "账户模型目录或来源文件无法安全解析", error); }
  if (!Array.isArray(catalog?.models) || !catalog.models.length || catalog.models.some(model => !model || typeof model.slug !== "string")
    || new Set(catalog.models.map(model => model.slug)).size !== catalog.models.length
    || !manifest || typeof manifest !== "object" || Array.isArray(manifest) || typeof manifest.source !== "string" || !manifest.source) {
    throw invalid("provider-state-unavailable", "provider", "账户模型目录或来源文件无效");
  }
  if (!isDeepStrictEqual(catalog.models.map(model => model.slug).sort(), visible.models.map(model => model.id).sort())) throw stale();
  const bindings = readModelTemplateBindings(manifest, catalog.models.map(model => model.slug));
  const scope = JSON.stringify([codexHomePath(environment), connectHomePath(environment), resolve(environment.CODEX_CONNECT_CONFIG_FILE?.trim() || join(connectHomePath(environment), "config.toml"))]);
  return { definition, family, providers: visible.providers, catalogPath, manifestPath, catalog, manifest, bindings, snapshots: files, scope,
    revision: revisionOf([provider, scope, visible, files.map(file => [file.path, file.content?.toString("base64") ?? null])]) };
}

function validateModel(model, definition) {
  if (!isManagedProviderModelValid(definition, model.slug)) throw invalid("addition-source-invalid", "models", "新增模型 ID 不符合该提供商约束");
  withManagedModelCatalogSettings({ models: [model] }, definition, { model: model.slug, reasoningEffort: model.default_reasoning_level });
}

function content(files, path) { return files.find(file => file.path === path)?.content?.toString("utf8"); }
