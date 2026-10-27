import { createHmac, randomBytes } from "node:crypto";
import { join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { codexHomePath } from "../runtime/codex-home.mjs";
import { connectHomePath } from "../runtime/connect-home.mjs";
import { loadManagedModelProviderDefinitions, managedProviderAccountFamilies, isManagedProviderModelValid } from "../runtime/model-provider-definitions.mjs";
import { managedProviderDirectory, managedProviderMarkerPath, withManagedModelCatalogSettings, writeManagedModelProviderCatalogUpdates, customPrimaryProviderProfilePath, customSwitchingProviderRegistryPath } from "../runtime/model-provider-runtime.mjs";
import { createResponsesModelCatalog, readResponsesModelCatalog, writeResponsesModelCatalog, withResponsesModelCatalogWrite, finishResponsesModelCatalogWrite, compileResponsesModelCatalog } from "../runtime/model-provider-responses-catalog.mjs";
import { customProviderUpstreamMetadataPath, readCustomProviderUpstreamWireApi } from "../runtime/model-provider-upstream-metadata.mjs";
import { withThirdPartyLocalTools } from "../runtime/third-party-model-catalog.mjs";
import { readDeepseekModelTemplateCatalog, readModelBaseSnapshot, withModelBaseSnapshotLock } from "../runtime/model-base-snapshot.mjs";
import { resolveClinePassRequestProfile } from "../runtime/chat-reasoning.mjs";
import { validateClinePassProviderOptions } from "../runtime/cline-provider-options.mjs";
import { createIndependentModelDraft, defaultModelDisplayName, isValidCustomModelId } from "../runtime/model-catalog.mjs";
import { readModelTemplateBindings, validateOllamaCloudCatalogManifest } from "../runtime/model-template-bindings.mjs";
import { loadProviderModelCatalogs, ProviderModelManagementError } from "./provider-model-management.mjs";
import { downloadDeepseekCatalog } from "./deepseek-setup.mjs";
import { createCcgCatalogWithTemplateBindings, createOpencodeGoCatalogWithTemplateBindings, createClinePassCatalogWithTemplateBindings, createOllamaCloudCatalogWithTemplateBindings } from "./provider-model-catalog.mjs";
import { snapshotProviderFiles, assertProviderFileSnapshots } from "./managed-provider-files.mjs";
import { withModelProviderManagementTransaction } from "./model-provider-management-transaction.mjs";
import { validateModelCatalogWithCodex } from "./model-catalog-validation.mjs";
import { loadConfiguredManagedProviderMaterial } from "../runtime/model-provider-managed-runtime.mjs";
import { discoverOllamaCloudModels } from "./ollama-cloud-catalog.mjs";
import { withOllamaCloudFetch, verifyOllamaCloudResponses } from "./ollama-cloud-model-verification.mjs";

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
  environment = process.env, signal, manualModel, fetchImpl, discovery,
  downloadCatalog = downloadDeepseekCatalog,
} = {}) {
  try {
    const deadline = globalThis.AbortSignal.timeout(90_000);
    const operationSignal = signal ? globalThis.AbortSignal.any([signal, deadline]) : deadline;
    operationSignal.throwIfAborted();
    const state = await readState(provider, environment);
    if (discovery !== undefined && (discovery !== true || manualModel !== undefined || state.family.storageId !== "ollama-cloud")) {
      throw invalid("invalid-input", "provider", "公开发现仅用于 OLC，不能与手动模型混用");
    }
    const baseRevision = manualModel && typeof manualModel === "object" && Object.hasOwn(manualModel, "inheritFrom")
      ? undefined : readModelBaseSnapshot(environment).revision;
    let models, bindings = {}, source;
    if (manualModel && typeof manualModel === "object" && Object.hasOwn(manualModel, "inheritFrom")) {
      if (Array.isArray(manualModel)
        || Object.keys(manualModel).some(key => !["id", "name", "inheritFrom"].includes(key))
        || !validModelId(state, manualModel.id) || !validModelId(state, manualModel.inheritFrom)
        || typeof manualModel.name !== "string" || !manualModel.name.trim() || manualModel.name.length > 120 || /\p{Cc}/u.test(manualModel.name)) {
        throw invalid("invalid-input", "manualModel", "请提供同一目录中有效的新 ID、名称及继承来源，不混入独立能力字段");
      }
      if (state.catalog.models.some(model => model.slug === manualModel.id)) throw invalid("model-exists", "manualModel", "模型 ID 已存在，新增不能覆盖已有模型");
      const original = state.catalog.models.find(model => model.slug === manualModel.inheritFrom);
      if (!original) throw invalid("invalid-input", "manualModel", "继承来源不在当前目录中，请重新选择");
      const profile = state.family.storageId === "clp" ? resolveClinePassRequestProfile(original.slug, original.cline_request_profile) : undefined;
      if (state.custom) {
        const model = structuredClone(state.previous.definitions.find(model => model.id === original.slug));
        delete model.template;
        models = [{ ...model, id: manualModel.id, name: manualModel.name.trim() }];
      } else models = [{ ...structuredClone(original), slug: manualModel.id, display_name: manualModel.name.trim(), ...(profile ? { cline_request_profile: profile } : {}) }];
      source = { kind: "inherited", model: original.slug, ...(profile ? { clineRequestProfile: profile } : {}) };
    } else if (manualModel !== undefined) {
      if (manualModel && typeof manualModel === "object" && Object.hasOwn(manualModel, "sampling")) {
        throw invalid("invalid-input", "manualModel", "受管模型手动新增不支持默认采样参数；sampling 不会保存，请移除此字段");
      }
      if (!["ccg", "opencode-go", "clp", "ollama-cloud", "custom"].includes(state.family.storageId)
        || !manualModel || typeof manualModel !== "object" || Array.isArray(manualModel)
        || !validModelId(state, manualModel.id)
        || manualModel.experimentalSupportedTools !== undefined && !Array.isArray(manualModel.experimentalSupportedTools)
        || manualModel.modelMessages !== undefined && (!manualModel.modelMessages || typeof manualModel.modelMessages !== "object" || Array.isArray(manualModel.modelMessages))
        || !Array.isArray(manualModel.reasoningEfforts) || manualModel.reasoningEfforts.length === 0
        || typeof manualModel.supportsImages !== "boolean" || typeof manualModel.supportsSearchTool !== "boolean"
        || ![null, "freeform"].includes(manualModel.applyPatchToolType) || manualModel.template !== undefined) {
        throw invalid("invalid-input", "manualModel", "须明确声明思考等级、图片、apply_patch 和 tool_search 能力，不自动关联模板");
      }
      const clinePass = state.family.storageId === "clp";
      if (state.family.storageId === "ollama-cloud" && manualModel.supportsWebSearch !== undefined && manualModel.supportsWebSearch !== false) {
        throw invalid("invalid-input", "manualModel", "OLC 尚未开放原生 web_search 能力声明");
      }
      const chat = clinePass || state.upstreamWireApi === "chat_completions";
      if (chat && manualModel.supportsImageDetailOriginal !== undefined && manualModel.supportsImageDetailOriginal !== false) {
        throw invalid("invalid-input", "manualModel", "Chat 桥不支持 original 图片细节");
      }
      if (chat && (manualModel.supportsReasoningSummary === true
        || manualModel.defaultReasoningSummary !== undefined && manualModel.defaultReasoningSummary !== "none")) {
        throw invalid("invalid-input", "manualModel", "Chat 桥不支持思考摘要控制");
      }
      try {
        const catalog = createResponsesModelCatalog([{ ...createIndependentModelDraft(manualModel),
          ...(chat ? { supportsImageDetailOriginal: false } : {}),
        }], manualModel.id, { allowReasoningToggle: clinePass }, environment);
        models = state.custom ? catalog.definitions : withThirdPartyLocalTools(catalog, environment).models;
        validateModel(models[0], state);
      } catch (error) {
        throw invalid("invalid-input", "manualModel", "手动模型 ID、上下文、默认思考等级或能力定义无效", error);
      }
      if (state.catalog.models.some(model => model.slug === manualModel.id)) throw invalid("model-exists", "manualModel", "模型 ID 已存在，新增不能覆盖已有模型");
      source = { kind: "manual" };
    } else if (state.family.storageId === "clp") {
      const generated = createClinePassCatalogWithTemplateBindings(readDeepseekModelTemplateCatalog(environment), environment);
      models = generated.catalog.models;
      bindings = generated.templateBindings;
      source = { kind: "deepseek" };
    } else if (state.family.storageId === "ollama-cloud" && discovery !== true) {
      const generated = createOllamaCloudCatalogWithTemplateBindings(readDeepseekModelTemplateCatalog(environment), environment);
      models = generated.catalog.models;
      bindings = generated.templateBindings;
      source = { kind: "ollama-managed" };
    } else if (state.family.storageId === "ollama-cloud") {
      const material = loadConfiguredManagedProviderMaterial(provider, environment);
      const discovery = await withOllamaCloudFetch(environment, operationSignal,
        fetch => discoverOllamaCloudModels({ fetchImpl: fetch, signal: operationSignal }), fetchImpl);
      operationSignal.throwIfAborted();
      if ((await readState(provider, environment)).revision !== state.revision
        || loadConfiguredManagedProviderMaterial(provider, environment).revision !== material.revision
        || readModelBaseSnapshot(environment).revision !== baseRevision) throw stale();
      const snapshot = { provider, providers: state.providers, scope: state.scope, revision: state.revision,
        source: { kind: "ollama-discovery", discovery }, materialRevision: material.revision, baseRevision,
        candidates: [], discovery: discovery.candidates.map(candidate => ({ ...candidate,
          alreadySaved: state.catalog.models.some(model => model.slug === candidate.id) })), expiresAt: Date.now() + lifetimeMs };
      return retainSnapshot(snapshot);
    } else if (state.custom) {
      throw invalid("invalid-input", "manualModel", "自定义提供商新增模型必须填写准确 ID 及能力，或选择已有模型继承");
    } else {
      const downloaded = await downloadCatalog(globalThis.fetch, { signal: operationSignal });
      operationSignal.throwIfAborted();
      const generated = (state.family.storageId === "ccg" ? createCcgCatalogWithTemplateBindings : createOpencodeGoCatalogWithTemplateBindings)(downloaded.catalog, environment);
      models = generated.catalog.models;
      bindings = generated.templateBindings;
      source = { kind: "deepseek", sha256: downloaded.sha256 };
    }
    operationSignal.throwIfAborted();
    const idOf = model => state.custom ? model?.id : model?.slug;
    if (!Array.isArray(models) || models.some(model => typeof idOf(model) !== "string")
      || new Set(models.map(idOf)).size !== models.length) throw invalid("addition-source-invalid", "models", "新增来源包含无效或重复的模型 ID");
    const candidates = models.filter(model => !state.catalog.models.some(saved => saved.slug === idOf(model))).map(model => {
      validateModel(model, state);
      return { model: idOf(model), displayName: state.custom ? model.name : model.display_name ?? model.slug, fields: model,
        ...(source.kind === "inherited" ? { inheritedFrom: source.model } : {}),
        ...(source.clineRequestProfile === undefined ? {} : { clineRequestProfile: source.clineRequestProfile }),
        ...(state.family.storageId === "clp" && model.cline_provider_options !== undefined ? {
          clineProviderOptions: validateClinePassProviderOptions(model.cline_provider_options),
        } : {}),
        ...(Object.hasOwn(bindings, model.slug) ? { template: bindings[model.slug] } : {}) };
    });
    if (candidates.length > maximumCandidates) throw invalid("addition-source-too-large", "models", "新增候选超过 128 个，请缩小源目录后重试");
    const current = await readState(provider, environment);
    if (current.revision !== state.revision) throw stale();
    operationSignal.throwIfAborted();
    if (baseRevision !== undefined && readModelBaseSnapshot(environment).revision !== baseRevision) throw stale();
    const snapshot = { provider, providers: state.providers, scope: state.scope, revision: state.revision, source, baseRevision,
      candidates, expiresAt: Date.now() + lifetimeMs };
    return retainSnapshot(snapshot);
  } catch (error) { throw stateError(error); }
}

function retainSnapshot(snapshot) {
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
  const { provider, revision, expiresAt, providers, candidates, discovery } = snapshot;
  return structuredClone({ provider, sourceToken, revision, expiresAt, providers, candidates, ...(discovery ? { discovery } : {}) });
}

/** A paid operation is separate from loading and saving; only server-owned candidates qualify. */
export async function verifyProviderModelAddition(input, { environment = process.env, signal, fetchImpl } = {}) {
  const operationSignal = globalThis.AbortSignal.any([globalThis.AbortSignal.timeout(90_000), ...(signal ? [signal] : [])]);
  try {
    operationSignal.throwIfAborted();
    if (!input || typeof input !== "object" || Array.isArray(input)
      || Object.keys(input).some(key => !["provider", "sourceToken", "revision", "model", "reasoningEfforts", "confirmPaid"].includes(key))
      || input.confirmPaid !== true || typeof input.provider !== "string" || typeof input.model !== "string"
      || !/^[a-f0-9]{64}$/u.test(input.sourceToken ?? "") || !/^[a-f0-9]{64}$/u.test(input.revision ?? "")
      || !Array.isArray(input.reasoningEfforts) || !input.reasoningEfforts.length || input.reasoningEfforts.length > 7
      || new Set(input.reasoningEfforts).size !== input.reasoningEfforts.length) throw invalid("invalid-input", "models", "请明确确认可能收费的单模型验证及思考等级");
    const snapshot = snapshots.get(input.sourceToken);
    if (!snapshot || snapshot.expiresAt <= Date.now()) throw invalid("addition-source-expired", "sourceToken", "发现候选已过期，请重新发现");
    const state = await readState(input.provider, environment);
    if (snapshot.source.kind !== "ollama-discovery" || snapshot.provider !== input.provider
      || state.family.storageId !== "ollama-cloud" || snapshot.scope !== state.scope
      || snapshot.revision !== state.revision || input.revision !== state.revision) throw stale();
    assertSourceBase(snapshot, environment);
    const candidate = snapshot.source.discovery.candidates.find(entry => entry.id === input.model);
    if (candidate?.status !== "candidate" || state.catalog.models.some(model => model.slug === input.model)
      || !input.reasoningEfforts.includes(candidate.defaultReasoningEffort)
      || input.reasoningEfforts.some(effort => !candidate.reasoningEfforts.includes(effort))) throw invalid("addition-unavailable", "models", "请选择未保存的有效候选，验证等级必须包含来源默认等级");
    const material = loadConfiguredManagedProviderMaterial(input.provider, environment);
    if (snapshot.materialRevision !== material.revision || material.baseUrl !== "https://ollama.com/v1") throw stale();
    // Reject a locally invalid draft before sending any paid request.
    let displayName = "";
    for (const character of defaultModelDisplayName(candidate.id) || candidate.id) {
      if (displayName.length + character.length > 120) break;
      displayName += character;
    }
    const generated = withThirdPartyLocalTools(createResponsesModelCatalog([createIndependentModelDraft({
      id: candidate.id, name: displayName,
      contextWindow: candidate.proposedContextWindow, maxContextWindow: candidate.proposedContextWindow,
      reasoningEfforts: input.reasoningEfforts, defaultReasoningEffort: candidate.defaultReasoningEffort,
      supportsImages: false, supportsImageDetailOriginal: false, applyPatchToolType: null, supportsSearchTool: false,
    })], candidate.id, {}, environment), environment).models[0];
    validateModel(generated, state);
    const proposedCatalog = { ...state.catalog, models: [...state.catalog.models, generated] };
    if (state.catalog.models.length >= 64 || Buffer.byteLength(`${JSON.stringify(proposedCatalog, null, 2)}\n`) > 2 * 1024 * 1024) {
      throw invalid("addition-source-too-large", "models", "新增后的目录超过模型数量或 2 MiB 大小限制，未开始收费验证");
    }
    const discovery = snapshot.source.discovery;
    const provenanceSource = { model: candidate.id, generatorVersion: 1, sources: discovery.sources, fetchedAt: discovery.fetchedAt,
      modelsSha256: discovery.modelsSha256, tagsSha256: discovery.tagsSha256, showSha256: candidate.showSha256,
      fingerprint: candidate.fingerprint, upstreamContextWindow: candidate.upstreamContextWindow, contextWindowPolicyCap: 393_216 };
    const verificationFields = { reasoningEfforts: [...input.reasoningEfforts], jsonReasoningEffort: candidate.defaultReasoningEffort,
      requests: input.reasoningEfforts.length * 2 + 2, scope: "responses-sse-and-json-default-roundtrip" };
    // Validate prospective format and capacity only; no verification fact is retained
    // or exposed until the actual round trips below succeed.
    validateOllamaCloudCatalogManifest({ ...state.manifest, modelDiscovery: { ...state.manifest.modelDiscovery,
      [candidate.id]: { ...provenanceSource, verification: { ...verificationFields, verifiedAt: discovery.fetchedAt } },
    } }, [...state.catalog.models.map(model => model.slug), candidate.id]);
    await validateModelCatalogWithCodex(proposedCatalog, environment);
    operationSignal.throwIfAborted();
    // One attempt per discovery token prevents accidental duplicate paid submissions.
    if (snapshots.get(input.sourceToken) !== snapshot || snapshot.expiresAt <= Date.now()) throw invalid("addition-source-expired", "sourceToken", "发现候选已使用或过期，请重新发现");
    snapshots.delete(input.sourceToken);
    const result = await withOllamaCloudFetch(environment, operationSignal, async fetch => {
      const assertSubmission = async () => {
        operationSignal.throwIfAborted();
        if (snapshot.expiresAt <= Date.now() || (await readState(input.provider, environment)).revision !== state.revision
          || loadConfiguredManagedProviderMaterial(input.provider, environment).revision !== material.revision) throw stale();
        assertSourceBase(snapshot, environment);
        operationSignal.throwIfAborted();
      };
      const assertCurrent = async () => {
        operationSignal.throwIfAborted();
        const refreshed = await discoverOllamaCloudModels({ fetchImpl: fetch, signal: operationSignal });
        if (!isDeepStrictEqual(sourceIdentity(refreshed), sourceIdentity(snapshot.source.discovery))) throw stale();
        await assertSubmission();
      };
      await assertCurrent();
      const result = await verifyOllamaCloudResponses({ model: candidate.id, reasoningEfforts: input.reasoningEfforts,
        defaultReasoningEffort: candidate.defaultReasoningEffort, apiKey: material.apiKey,
        signal: operationSignal, fetchImpl: fetch, assertCurrent: assertSubmission });
      if (result.status === "verified") await assertCurrent();
      return result;
    }, fetchImpl);
    if (result.status !== "verified") return result;
    operationSignal.throwIfAborted();
    const provenance = { ...provenanceSource, verification: { ...verificationFields, verifiedAt: result.verifiedAt,
      jsonReasoningEffort: result.jsonReasoningEffort, requests: result.requests } };
    const options = retainSnapshot({ provider: input.provider, providers: state.providers, scope: state.scope, revision: state.revision,
      source: { kind: "ollama-verified", model: candidate.id, provenance }, materialRevision: material.revision,
      baseRevision: snapshot.baseRevision, candidates: [{ model: candidate.id, displayName: generated.display_name, fields: generated,
        ollamaVerification: provenance.verification }], expiresAt: Date.now() + lifetimeMs });
    return { ...result, options };
  } catch (error) { throw stateError(error); }
}

function sourceIdentity(discovery) {
  const identity = { ...discovery };
  delete identity.fetchedAt;
  // The public /v1/models data order varies between identical ID sets. Its raw
  // hash is provenance only; sorted exact IDs and all consumed tags/show fields
  // remain bound by candidates, tagsSha256 and the per-model fingerprints.
  delete identity.modelsSha256;
  return identity;
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
    const selectedSource = snapshots.get(input.sourceToken);
    const withSourceLock = selectedSource?.baseRevision === undefined
      ? operation => operation() : operation => withModelBaseSnapshotLock(environment, operation);
    return withSourceLock(async () => {
      await assertProviderFileSnapshots(plan.state.snapshots).catch(() => { throw stale(); });
      const snapshot = snapshots.get(input.sourceToken);
      if (!snapshot || snapshot.expiresAt <= Date.now()) throw invalid("addition-source-expired", "sourceToken", "新增候选已过期，请重新读取并预览");
      assertSourceBase(snapshot, environment);
      try {
        if (plan.state.custom) {
          const transaction = writeResponsesModelCatalog(environment, input.provider, plan.customCatalog.definitions,
            plan.state.previous.defaultModel, plan.state.previous.revision);
          await withResponsesModelCatalogWrite(transaction, async () => {
            if (readResponsesModelCatalog(environment, input.provider).content !== transaction.content) throw new Error("新增目录回读不一致");
            const written = new Set([transaction.path, `${transaction.path}.backup`, `${transaction.path}.pending`]);
            await assertProviderFileSnapshots(plan.state.snapshots.filter(file => !written.has(file.path)));
            finishResponsesModelCatalogWrite(transaction);
          });
        } else writeManagedModelProviderCatalogUpdates(input.provider, plan.updates,
          new Map(plan.state.snapshots.filter(snapshot => !snapshot.path.endsWith(".settings-pending"))
            .map(snapshot => [snapshot.path, snapshot.content?.toString("utf8")])), environment);
      } catch (error) {
        throw invalid("operation-failed", "models", "新增模型保存未完成；请核对原目录、备份与恢复记录，勿自动重试", error);
      }
      snapshots.delete(input.sourceToken);
      return { action: "catalog-updated", activation: "restart-all", models: plan.models };
    });
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
  if (snapshot.source.kind === "ollama-discovery") throw invalid("addition-unavailable", "models", "公开候选必须先明确确认并通过单模型 Responses 验证");
  const state = await readState(input.provider, environment);
  if (snapshot.provider !== input.provider || snapshot.scope !== state.scope || snapshot.revision !== state.revision
    || input.revision !== snapshot.revision) throw stale();
  assertSourceBase(snapshot, environment);
  if (snapshot.materialRevision !== undefined) {
    const material = loadConfiguredManagedProviderMaterial(input.provider, environment);
    if (material.revision !== snapshot.materialRevision) throw stale();
    const additional = snapshotProviderFiles(material.paths.filter(path => !state.snapshots.some(file => file.path === path)), environment);
    if (loadConfiguredManagedProviderMaterial(input.provider, environment).revision !== snapshot.materialRevision) throw stale();
    state.snapshots.push(...additional);
  }
  const additions = snapshot.candidates.filter(candidate => input.models.includes(candidate.model));
  if (additions.length !== input.models.length || additions.some(candidate => state.catalog.models.some(model => model.slug === candidate.model))) {
    throw invalid("addition-unavailable", "models", "所选模型不在当前新增候选中，或 ID 已存在");
  }
  if (additions.length && state.catalog.models.length + additions.length > 64) throw invalid("invalid-input", "models", "保存后的模型目录最多允许 64 个模型");
  if (state.custom) {
    const customCatalog = compileResponsesModelCatalog([...state.previous.definitions, ...additions.map(candidate => candidate.fields)], state.previous.defaultModel);
    if (validate && additions.length) await validateModelCatalogWithCodex(customCatalog, environment);
    await assertProviderFileSnapshots(state.snapshots);
    assertSourceBase(snapshot, environment);
    if (snapshot.expiresAt <= Date.now() || snapshots.get(input.sourceToken) !== snapshot) throw invalid("addition-source-expired", "sourceToken", "新增候选已过期，请重新读取并预览");
    const preview = { provider: input.provider, providers: state.providers, additions: structuredClone(additions),
      revision: revisionOf([state.revision, input.sourceToken, snapshot.source, additions]),
      willChange: additions.length > 0, activation: additions.length ? "restart-all" : "none" };
    return { state, preview, customCatalog, models: customCatalog.models.map(model => model.slug) };
  }
  const catalog = { ...state.catalog, models: [...state.catalog.models, ...additions.map(candidate => candidate.fields)] };
  const bindings = { ...state.bindings, ...Object.fromEntries(additions.filter(candidate => candidate.template).map(candidate => [candidate.model, candidate.template])) };
  const manifest = { ...state.manifest,
    ...(snapshot.source.kind === "ollama-verified" && additions.length ? {
      modelDiscovery: { ...state.manifest.modelDiscovery, [snapshot.source.model]: snapshot.source.provenance },
    } : {}),
    ...(state.manifest.modelTemplates !== undefined || Object.keys(bindings).length ? { modelTemplates: bindings } : {}),
    ...(state.family.storageId === "clp" && state.manifest.cline !== undefined && additions.length ? {
      ...(additions.some(model => model.model === state.definition.defaultModel) ? { source: "deepseek", model: "deepseek-flash" } : {}),
    } : {}),
  };
  if (state.family.storageId === "ollama-cloud") validateOllamaCloudCatalogManifest(manifest, catalog.models.map(model => model.slug));
  if (validate && additions.length) await validateModelCatalogWithCodex(catalog, environment);
  await assertProviderFileSnapshots(state.snapshots);
  if (snapshot.expiresAt <= Date.now() || snapshots.get(input.sourceToken) !== snapshot) throw invalid("addition-source-expired", "sourceToken", "新增候选已过期，请重新读取并预览");
  assertSourceBase(snapshot, environment);
  const preview = { provider: input.provider, providers: state.providers, additions: structuredClone(additions),
    revision: revisionOf([state.revision, input.sourceToken, snapshot.source, additions]),
    willChange: additions.length > 0, activation: additions.length ? "restart-all" : "none" };
  return { state, preview, models: catalog.models.map(model => model.slug), updates: new Map([
    [`${state.catalogPath}.backup`, content(state.snapshots, state.catalogPath)],
    [`${state.manifestPath}.backup`, content(state.snapshots, state.manifestPath)],
    [state.catalogPath, `${JSON.stringify(catalog, null, 2)}\n`], [state.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`],
  ]) };
}

function assertSourceBase(snapshot, environment) {
  if (snapshot.baseRevision !== undefined && snapshot.baseRevision !== readModelBaseSnapshot(environment).revision) throw stale();
}

async function readState(provider, environment) {
  if (typeof provider !== "string" || !provider || provider.length > 200) throw invalid("invalid-input", "provider", "请选择准确提供商账户");
  if (provider.startsWith("cp-")) {
    const { catalogs } = await loadProviderModelCatalogs({ environment });
    const visible = catalogs.find(catalog => catalog.provider === provider && catalog.canRemove);
    if (!visible) throw invalid("addition-unavailable", "provider", "请先配置使用独立模型目录的自定义提供商");
    const previous = readResponsesModelCatalog(environment, provider);
    const files = snapshotProviderFiles([previous.path, `${previous.path}.backup`, `${previous.path}.pending`,
      join(codexHomePath(environment), "config.toml"), customPrimaryProviderProfilePath(environment, provider),
      customSwitchingProviderRegistryPath(environment), customProviderUpstreamMetadataPath(environment, provider)], environment);
    if (content(files, previous.path) !== previous.content
      || !isDeepStrictEqual(visible.models.map(model => model.id).sort(), previous.models.map(model => model.slug).sort())) throw stale();
    const scope = JSON.stringify([codexHomePath(environment), connectHomePath(environment), resolve(environment.CODEX_CONNECT_CONFIG_FILE?.trim() || join(connectHomePath(environment), "config.toml"))]);
    return { custom: true, family: { storageId: "custom" }, providers: [provider], previous, catalog: previous, snapshots: files, scope,
      upstreamWireApi: readCustomProviderUpstreamWireApi(environment, provider),
      revision: revisionOf([provider, scope, visible, files.map(file => [file.path, file.content?.toString("base64") ?? null])]) };
  }
  const definitions = loadManagedModelProviderDefinitions(environment);
  const definition = definitions.find(entry => entry.id === provider);
  const family = managedProviderAccountFamilies.find(entry => entry.storageId === definition?.storageId);
  if (!definition || !family || !["ccg", "opencode-go", "clp", "ollama-cloud"].includes(family.storageId)) throw invalid("addition-unavailable", "provider", "新增仅支持已配置的 CCG、OCG、CLP 或 OLC 账户");
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
  if (family.storageId === "ollama-cloud") validateOllamaCloudCatalogManifest(manifest, catalog.models.map(model => model.slug));
  const scope = JSON.stringify([codexHomePath(environment), connectHomePath(environment), resolve(environment.CODEX_CONNECT_CONFIG_FILE?.trim() || join(connectHomePath(environment), "config.toml"))]);
  return { definition, family, providers: visible.providers, catalogPath, manifestPath, catalog, manifest, bindings, snapshots: files, scope,
    revision: revisionOf([provider, scope, visible, files.map(file => [file.path, file.content?.toString("base64") ?? null])]) };
}

function validModelId(state, id) {
  return state.custom ? isValidCustomModelId(id)
    : isManagedProviderModelValid(state.definition, id);
}

function validateModel(model, state) {
  if (state.custom) { compileResponsesModelCatalog([model], model.id); return; }
  if (!isManagedProviderModelValid(state.definition, model.slug)) throw invalid("addition-source-invalid", "models", "新增模型 ID 不符合该提供商约束");
  if (state.family.storageId === "clp") {
    try { validateClinePassProviderOptions(model.cline_provider_options); }
    catch (error) { throw invalid("addition-source-invalid", "models", "新增模型的请求改写无效", error); }
  }
  withManagedModelCatalogSettings({ models: [model] }, state.definition, { model: model.slug, reasoningEffort: model.default_reasoning_level });
}

function content(files, path) { return files.find(file => file.path === path)?.content?.toString("utf8"); }
