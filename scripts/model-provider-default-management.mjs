import { createHmac, randomBytes } from "node:crypto";
import { join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { codexHomePath } from "../runtime/codex-home.mjs";
import { loadManagedModelProviderDefinitions, managedProviderAccountFamilyForDefinition } from "../runtime/model-provider-definitions.mjs";
import {
  managedProviderDirectory,
  managedProviderMarkerPath,
  readManagedModelProviderCatalogContent,
  restoreManagedModelProviderCatalogContent,
  loadManagedModelProviderSettings,
  writeManagedModelProviderCatalogSettings,
  writeManagedModelProviderProfileDefault,
} from "../runtime/model-provider-runtime.mjs";
import {
  areCodexUserConfigEditsApplied,
  readCodexUserConfigSnapshot,
  writeCodexUserConfigEdits,
} from "./codex-user-config.mjs";
import { withModelProviderManagementTransaction } from "./model-provider-management-transaction.mjs";
import { snapshotProviderFiles, assertProviderFileSnapshots } from "./managed-provider-files.mjs";

const revisionSecret = randomBytes(32);

export class ModelProviderDefaultManagementError extends Error {
  constructor(code, field, message, options) {
    super(message, options);
    this.name = "ModelProviderDefaultManagementError";
    this.code = code;
    this.field = field;
  }
}

export function previewManagedProviderDefaultChange(
  input,
  options = {},
) {
  return publicPreview(buildPlan(input, options));
}

export async function applyManagedProviderDefaultChange(
  input,
  options = {},
) {
  const environment = options.environment ?? process.env;
  return withModelProviderManagementTransaction(
    environment,
    () => applyManagedProviderDefaultChangeUnlocked(input, options),
    { withFileLock: options.withFileLock },
  );
}

async function applyManagedProviderDefaultChangeUnlocked(
  input,
  {
    environment = process.env,
    loadProviders = loadManagedModelProviderSettings,
    writeProfileDefault = writeManagedModelProviderProfileDefault,
    writeCatalogSettings = writeManagedModelProviderCatalogSettings,
    readCatalogContent = readManagedModelProviderCatalogContent,
    restoreCatalogContent = restoreManagedModelProviderCatalogContent,
    writeConfigEdits = writeCodexUserConfigEdits,
    readConfigSnapshot = readCodexUserConfigSnapshot,
    loadDefinitions = loadManagedModelProviderDefinitions,
    preview,
  } = {},
) {
  const plan = buildPlan(input, { environment, loadProviders, loadDefinitions });
  const confirmed = { ...preview };
  delete confirmed.operation;
  if (!preview || !isDeepStrictEqual(confirmed, publicPreview(plan))) {
    throw invalid("stale-preview", "revision", "账户模型、共享目录或相关配置已变化，请重新预览并确认");
  }
  try {
    await assertProviderFileSnapshots(plan.snapshots);
    if (plan.provider.mode === "switching") {
      writeProfileDefault(plan.provider.provider, plan.settings, environment);
    } else {
      const edits = exclusiveConfigEdits(plan.model.model);
      const snapshot = await readConfigSnapshot(environment);
      await assertProviderFileSnapshots(plan.snapshots);
      const previousContent = readCatalogContent(plan.provider.provider, environment);
      writeCatalogSettings(plan.provider.provider, plan.settings, environment);
      // A failed asynchronous config write must not roll back a later edit to
      // the catalog, its mirrored profiles, membership, or primary selection.
      let rollbackSnapshots;
      try {
        rollbackSnapshots = snapshotProviderFiles(plan.snapshots.map(entry => entry.path), environment);
      } catch (error) {
        throw invalid("save-unconfirmed", "action", "目录已保存，但无法确认恢复材料；请核对当前配置与目录备份，勿自动重试", error);
      }
      let current;
      try {
        await writeConfigEdits(environment, edits, { expectedVersion: snapshot.version });
      } catch (error) {
        try {
          current = await readConfigSnapshot(environment);
        } catch (confirmationError) {
          throw invalid("save-unconfirmed", "action", "默认模型保存结果无法确认，已保留当前配置与目录备份；请核对后处理，勿自动重试", confirmationError);
        }
        if (current.config.model_provider !== plan.provider.provider) {
          throw invalid("save-unconfirmed", "action", "保存期间主 Provider 已变化，已保留当前配置与目录备份；请核对后处理，勿自动重试", error);
        }
        if (!areCodexUserConfigEditsApplied(current.config, edits)) {
          try {
            await assertProviderFileSnapshots(rollbackSnapshots);
          } catch (error) {
            throw invalid("save-unconfirmed", "action", "保存后配置或目录存在后续修改，拒绝自动回滚；请核对当前文件与目录备份", error);
          }
          try {
            restoreCatalogContent(plan.provider.provider, previousContent, environment);
          } catch (rollbackError) {
            throw new AggregateError(
              [error, rollbackError],
              "第三方模型设置失败，且未能恢复模型目录",
              { cause: rollbackError },
            );
          }
          throw error;
        }
      }
      try {
        current ??= await readConfigSnapshot(environment);
        if (current.config.model_provider !== plan.provider.provider
          || !areCodexUserConfigEditsApplied(current.config, edits)) {
          throw new Error("主配置回读与已确认设置不一致");
        }
      } catch (error) {
        throw invalid("save-unconfirmed", "action", "默认模型保存结果无法确认，已保留当前配置与目录备份；请核对后处理，勿自动重试", error);
      }
    }
    try {
      const observed = loadProviders(environment);
      for (const member of plan.providers) {
        const saved = observed.find(candidate => candidate.provider === member.provider);
        const expectedDefault = member.provider === plan.provider.provider ? plan.model.model : member.model;
        if (!saved || saved.mode !== member.mode || saved.model !== expectedDefault
          || saved.models.find(candidate => candidate.model === plan.model.model)?.reasoningEffort !== plan.settings.reasoningEffort) {
          throw new Error("账户默认模型或共享思考等级回读不一致");
        }
      }
    } catch (error) {
      throw invalid("save-unconfirmed", "action", "默认模型或共享等级保存结果无法确认，已保留当前配置与目录备份；请核对后处理，勿自动重试", error);
    }
  } catch (error) {
    if (error instanceof ModelProviderDefaultManagementError) throw error;
    throw invalid(
      "operation-failed",
      "action",
      "默认模型设置未完成；请检查提供商配置与目录备份后重新读取状态",
      error,
    );
  }
  return {
    action: "updated",
    ...publicPreview(plan),
  };
}

function buildPlan(input, {
  environment = process.env,
  loadProviders = loadManagedModelProviderSettings,
  loadDefinitions = loadManagedModelProviderDefinitions,
} = {}) {
  const values = record(input);
  if (Object.keys(values).some(key => !["provider", "model", "reasoningEffort"].includes(key))) {
    throw invalid("invalid-input", "action", "默认模型设置包含不支持的字段；上下文请使用模型目录管理入口");
  }
  const providerId = requiredString(values.provider, "provider", "Provider 不能为空");
  const definitions = loadDefinitions(environment);
  const definition = definitions.find(candidate => candidate.id === providerId);
  if (!definition) throw invalid("provider-not-configured", "provider", `第三方 Provider 未配置：${providerId}`);
  const family = managedProviderAccountFamilyForDefinition(definition);
  const members = definitions.filter(candidate => (candidate.storageId ?? candidate.id) === (definition.storageId ?? definition.id));
  const catalogPath = join(managedProviderDirectory(environment, definition), definition.catalogFileName);
  const snapshots = snapshotProviderFiles([
    catalogPath, join(managedProviderDirectory(environment, definition), definition.catalogManifestFileName),
    `${catalogPath}.settings-pending`,
    join(codexHomePath(environment), "config.toml"),
    ...members.flatMap(member => [join(codexHomePath(environment), member.profileFileName), managedProviderMarkerPath(environment, member)]),
    ...(family ? [family.accountsFilePath(environment)] : []),
  ], environment);
  const configured = loadProviders(environment);
  if (!isDeepStrictEqual(definitions, loadDefinitions(environment))) {
    throw invalid("stale-preview", "revision", "账户注册表在预览期间发生变化，请重新预览");
  }
  if (!Array.isArray(configured) || configured.length === 0) {
    throw invalid(
      "provider-not-configured",
      "provider",
      "尚未配置受管 Provider，请先在 Setup 中完成第三方账户接入",
    );
  }
  const provider = configured.find((candidate) => candidate.provider === providerId);
  if (provider === undefined) {
    throw invalid(
      "provider-not-configured",
      "provider",
      `第三方 Provider 未配置：${providerId}`,
    );
  }
  const modelId = requiredString(values.model, "model", "模型 ID 不能为空");
  const model = provider.models.find((candidate) => candidate.model === modelId);
  if (model === undefined) {
    throw invalid(
      "model-not-supported",
      "model",
      `${provider.displayName} 不支持模型：${modelId}`,
    );
  }
  const reasoningEffort = requiredString(
    values.reasoningEffort,
    "reasoningEffort",
    "思考等级不能为空",
  );
  if (!model.reasoningEfforts.some((candidate) => candidate.effort === reasoningEffort)) {
    throw invalid(
      "reasoning-effort-not-supported",
      "reasoningEffort",
      `${model.displayName} 不支持思考等级：${reasoningEffort}`,
    );
  }
  const providers = configured.filter(candidate => members.some(member => member.id === candidate.provider));
  const plan = {
    provider,
    providers,
    model,
    settings: { model: model.model, reasoningEffort },
    effects: {
      defaultModelProviders: [provider.provider],
      reasoningEffortProviders: providers.map(candidate => candidate.provider),
      profileReasoningEffortProviders: providers.filter(candidate => candidate.mode === "switching"
        && (candidate.provider === provider.provider || candidate.model === model.model)).map(candidate => candidate.provider),
    },
    willChange: provider.model !== model.model
      || model.reasoningEffort !== reasoningEffort,
    snapshots,
  };
  for (const snapshot of snapshots) {
    const current = snapshot.readCurrent();
    if (current === undefined || snapshot.content === undefined
      ? current !== snapshot.content : !current.equals(snapshot.content)) {
      throw invalid("stale-preview", "revision", "账户配置在预览期间发生变化，请重新预览");
    }
  }
  plan.revision = createHmac("sha256", revisionSecret).update(JSON.stringify({
    scope: resolve(codexHomePath(environment)), provider: providerId, model: modelId, reasoningEffort,
    providers, snapshots: snapshots.map(snapshot => [snapshot.path, snapshot.content?.toString("base64") ?? null]),
  })).digest("hex");
  return plan;
}

function publicPreview(plan) {
  return {
    provider: {
      id: plan.provider.provider,
      displayName: plan.provider.displayName,
      mode: plan.provider.mode,
    },
    model: {
      id: plan.model.model,
      displayName: plan.model.displayName,
      contextWindow: plan.model.contextWindow,
      maxContextWindow: plan.model.maxContextWindow,
    },
    reasoningEffort: plan.settings.reasoningEffort,
    revision: plan.revision,
    effects: structuredClone(plan.effects),
    before: {
      defaultModel: plan.provider.model,
      reasoningEffort: plan.model.reasoningEffort,
    },
    willChange: plan.willChange,
    activation: "restart-app-server",
  };
}

function exclusiveConfigEdits(model) {
  return [
    { keyPath: "model", value: model },
    { keyPath: "model_reasoning_effort", value: null },
    { keyPath: "model_context_window", value: null },
    { keyPath: "model_auto_compact_token_limit", value: null },
    { keyPath: "model_auto_compact_token_limit_scope", value: null },
  ];
}

function requiredString(value, field, message) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (normalized === "") throw invalid("required", field, message);
  return normalized;
}

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function invalid(code, field, message, cause) {
  return new ModelProviderDefaultManagementError(
    code,
    field,
    message,
    cause === undefined ? undefined : { cause },
  );
}
