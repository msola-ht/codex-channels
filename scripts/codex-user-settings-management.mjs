import { loadPrimaryModelProvider } from "../runtime/model-provider-runtime.mjs";
import { createCodexUserConfigClient } from "./codex-user-config.mjs";
import { supportedPublicApprovalPolicies } from "./codex-public-cli-contract.mjs";

const sandboxModes = new Set(["read-only", "workspace-write"]);
const approvalPolicies = new Set(supportedPublicApprovalPolicies);
const webSearchModes = new Set(["live", "indexed", "cached", "disabled"]);
const reasoningSummaries = new Set(["auto", "concise", "detailed", "none"]);
const verbosities = new Set(["low", "medium", "high"]);
const personalities = new Set(["none", "friendly", "pragmatic"]);
const historyPersistences = new Set(["save-all", "none"]);

export class CodexUserSettingsError extends Error {
  constructor(code, field, message, options) {
    super(message, options);
    this.name = "CodexUserSettingsError";
    this.code = code;
    this.field = field;
  }
}

export async function loadCodexUserSettings({
  environment = process.env,
  createClient = createCodexUserConfigClient,
  primaryProvider = loadPrimaryModelProvider,
} = {}) {
  const provider = primaryProvider(environment);
  const client = await createClient({ environment });
  try {
    await client.connect();
    const [snapshot, models] = await Promise.all([
      client.readUserConfigSnapshot(),
      provider === "openai" ? client.listModels() : Promise.resolve([]),
    ]);
    return projectSettings(snapshot, provider, models);
  } finally {
    await client.close().catch(() => undefined);
  }
}

export async function updateCodexUserSetting(
  input,
  {
    environment = process.env,
    expectedVersion,
    createClient = createCodexUserConfigClient,
    primaryProvider = loadPrimaryModelProvider,
  } = {},
) {
  if (typeof expectedVersion !== "string" || expectedVersion.trim() === "") {
    throw invalid("revision", "required-revision", "必须提供有效的 Codex 用户配置修订值");
  }
  const provider = primaryProvider(environment);
  if (["all", "defaults", "preferences"].includes(input?.kind)) {
    assertOfficialDefaults(provider);
  }
  const client = await createClient({ environment });
  try {
    await client.connect();
    const [snapshot, models] = await Promise.all([
      client.readUserConfigSnapshot(),
      ["all", "defaults", "preferences"].includes(input?.kind)
        ? client.listModels()
        : Promise.resolve([]),
    ]);
    if (snapshot.version !== expectedVersion) {
      throw invalid("revision", "stale-revision", "Codex 用户配置已变化，请重新读取设置");
    }
    const { edits, value } = createEdits(input, {
      config: snapshot.config,
      provider,
      models,
    });
    try {
      await client.writeUserConfigEdits(edits, { expectedVersion });
    } catch (error) {
      if (configWriteErrorCode(error) === "configVersionConflict") {
        throw invalid(
          "revision",
          "stale-revision",
          "Codex 用户配置已变化，请重新读取设置",
          { cause: error },
        );
      }
      throw error;
    }
    return {
      kind: input.kind,
      previousVersion: expectedVersion,
      value,
      activation: "restart-all",
    };
  } finally {
    await client.close().catch(() => undefined);
  }
}

/** Validate and project a change without writing the App Server config. */
export async function previewCodexUserSetting(
  input,
  {
    environment = process.env,
    expectedVersion,
    createClient = createCodexUserConfigClient,
    primaryProvider = loadPrimaryModelProvider,
  } = {},
) {
  if (typeof expectedVersion !== "string" || expectedVersion.trim() === "") {
    throw invalid("revision", "required-revision", "必须提供有效的 Codex 用户配置修订值");
  }
  const provider = primaryProvider(environment);
  if (["all", "defaults", "preferences"].includes(input?.kind)) {
    assertOfficialDefaults(provider);
  }
  const client = await createClient({ environment });
  try {
    await client.connect();
    const [snapshot, models] = await Promise.all([
      client.readUserConfigSnapshot(),
      ["all", "defaults", "preferences"].includes(input?.kind)
        ? client.listModels()
        : Promise.resolve([]),
    ]);
    if (snapshot.version !== expectedVersion) {
      throw invalid("revision", "stale-revision", "Codex 用户配置已变化，请重新读取设置");
    }
    const { value } = createEdits(input, {
      config: snapshot.config,
      provider,
      models,
    });
    return {
      kind: input.kind,
      previousVersion: expectedVersion,
      value,
      activation: "restart-all",
    };
  } finally {
    await client.close().catch(() => undefined);
  }
}

function projectSettings(snapshot, provider, rawModels) {
  const config = record(snapshot.config);
  const models = rawModels.filter((model) => model.available !== false).map(projectModel);
  const selectedModel = models.find((model) => model.model === optionalString(config.model))
    ?? models.find((model) => model.isDefault)
    ?? models[0]
    ?? null;
  const configuredEffort = optionalString(config.model_reasoning_effort);
  const effort = selectedModel?.reasoningEfforts.some(
    (candidate) => candidate.effort === configuredEffort,
  )
    ? configuredEffort
    : selectedModel?.defaultReasoningEffort ?? configuredEffort;
  const serviceTier = optionalString(config.service_tier);
  const webSearch = webSearchModes.has(config.web_search) ? config.web_search : null;
  const reasoningSummary = reasoningSummaries.has(config.model_reasoning_summary)
    ? config.model_reasoning_summary : null;
  const verbosity = verbosities.has(config.model_verbosity) ? config.model_verbosity : null;
  const personality = personalities.has(config.personality) ? config.personality : null;
  const history = record(config.history);
  const tools = record(config.tools);
  const updatePlan = record(tools.update_plan);
  const configuredPlanEffort = optionalString(config.plan_mode_reasoning_effort);
  const planModeReasoningEffort = models.some((model) => model.reasoningEfforts
    .some((option) => option.effort === configuredPlanEffort))
    ? configuredPlanEffort : null;
  const sandboxMode = sandboxModes.has(config.sandbox_mode) ? config.sandbox_mode : null;
  const approvalPolicy = approvalPolicies.has(config.approval_policy)
    ? config.approval_policy
    : null;
  const workspaceSandbox = record(config.sandbox_workspace_write);
  return {
    version: snapshot.version,
    provider,
    defaultsEditable: provider === "openai",
    models,
    defaults: {
      model: selectedModel?.model ?? optionalString(config.model),
      reasoningEffort: effort ?? null,
      fastEnabled: isFastServiceTier(serviceTier),
      webSearch,
      updatePlanEnabled: updatePlan.enabled === true,
      reasoningSummary,
      planModeReasoningEffort,
      verbosity,
      personality,
      checkForUpdateOnStartup: typeof config.check_for_update_on_startup === "boolean"
        ? config.check_for_update_on_startup : null,
      historyPersistence: historyPersistences.has(history.persistence) ? history.persistence : null,
    },
    permissions: {
      editable: optionalString(config.default_permissions) === null,
      defaultPermissions: optionalString(config.default_permissions),
      sandboxMode,
      approvalPolicy,
      networkAccess: typeof workspaceSandbox.network_access === "boolean"
        ? workspaceSandbox.network_access
        : null,
    },
  };
}

function createEdits(input, { config, provider, models }) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw invalid("input", "invalid-input", "Codex 用户设置输入必须是对象");
  }
  switch (input.kind) {
    case "all":
      return allEdits(input, provider, config, models);
    case "defaults":
      return defaultEdits(input, provider, models);
    case "fast":
      assertOfficialDefaults(provider);
      return fastEdits(input, provider, config, models);
    case "permissions":
      return permissionEdits(input, config);
    case "web-search":
      return webSearchEdits(input);
    case "update-plan":
      return updatePlanEdits(input);
    case "preferences":
      return preferenceEdits(input, models);
    default:
      throw invalid("kind", "unknown-setting", `未知 Codex 用户设置：${String(input.kind)}`);
  }
}

function allEdits(input, provider, config, models) {
  assertOfficialDefaults(provider);
  const defaults = defaultEdits(input, provider, models);
  const fast = fastEdit(input.fastEnabled, "fastEnabled");
  const permissions = permissionEdits(input, config);
  return {
    edits: [...defaults.edits, ...fast.edits, ...permissions.edits],
    value: {
      ...defaults.value,
      fastEnabled: fast.value.enabled,
      ...permissions.value,
    },
  };
}

function defaultEdits(input, provider, models) {
  assertOfficialDefaults(provider);
  const model = requiredString(input.model, "model", "模型");
  const selected = models.find((candidate) => candidate.available !== false
    && candidate.model === model);
  if (!selected) throw invalid("model", "unknown-model", `模型不可用：${model}`);
  const reasoningEffort = requiredString(
    input.reasoningEffort,
    "reasoningEffort",
    "思考等级",
  );
  if (!selected.supportedReasoningEfforts.some(
    (candidate) => candidate.effort === reasoningEffort,
  )) {
    throw invalid(
      "reasoningEffort",
      "unsupported-reasoning-effort",
      `模型 ${model} 不支持思考等级 ${reasoningEffort}`,
    );
  }
  return {
    edits: [
      { keyPath: "model", value: model },
      { keyPath: "model_reasoning_effort", value: reasoningEffort },
    ],
    value: { model, reasoningEffort },
  };
}

function fastEdits(input) {
  return fastEdit(input.enabled);
}

function webSearchEdits(input) {
  if (!webSearchModes.has(input?.mode)) {
    throw invalid("mode", "invalid-web-search", `联网搜索模式无效：${String(input?.mode)}`);
  }
  return {
    edits: [{ keyPath: "web_search", value: input.mode }],
    value: { mode: input.mode },
  };
}

function updatePlanEdits(input) {
  if (typeof input?.enabled !== "boolean") {
    throw invalid("enabled", "invalid-boolean", "计划清单工具状态必须是布尔值");
  }
  return {
    edits: [{ keyPath: "tools.update_plan.enabled", value: input.enabled }],
    value: { enabled: input.enabled },
  };
}

function preferenceEdits(input, models) {
  const fields = [
    ["reasoningSummary", reasoningSummaries],
    ["verbosity", verbosities],
    ["personality", personalities],
    ["historyPersistence", historyPersistences],
  ];
  for (const [field, allowed] of fields) {
    if (!allowed.has(input?.[field])) {
      throw invalid(field, `invalid-${field}`, `用户偏好无效：${String(input?.[field])}`);
    }
  }
  if (typeof input.checkForUpdateOnStartup !== "boolean") {
    throw invalid("checkForUpdateOnStartup", "invalid-boolean", "启动更新检查必须是布尔值");
  }
  const effort = requiredString(input.planModeReasoningEffort, "planModeReasoningEffort", "Plan 思考等级");
  if (!models.some((model) => model.supportedReasoningEfforts.some((option) => option.effort === effort))) {
    throw invalid("planModeReasoningEffort", "invalid-reasoning-effort", `Plan 思考等级不可用：${effort}`);
  }
  return {
    edits: [
      { keyPath: "model_reasoning_summary", value: input.reasoningSummary },
      { keyPath: "plan_mode_reasoning_effort", value: effort },
      { keyPath: "model_verbosity", value: input.verbosity },
      { keyPath: "personality", value: input.personality },
      { keyPath: "check_for_update_on_startup", value: input.checkForUpdateOnStartup },
      { keyPath: "history.persistence", value: input.historyPersistence },
    ],
    value: {
      reasoningSummary: input.reasoningSummary,
      planModeReasoningEffort: effort,
      verbosity: input.verbosity,
      personality: input.personality,
      checkForUpdateOnStartup: input.checkForUpdateOnStartup,
      historyPersistence: input.historyPersistence,
    },
  };
}

function fastEdit(enabled, field = "enabled") {
  if (typeof enabled !== "boolean") {
    throw invalid(field, "invalid-boolean", "Fast 状态必须是布尔值");
  }
  return {
    edits: [{ keyPath: "service_tier", value: enabled ? "fast" : "default" }],
    value: { enabled },
  };
}

function permissionEdits(input, config) {
  const defaultPermissions = optionalString(record(config).default_permissions);
  if (defaultPermissions !== null) {
    throw invalid(
      "sandboxMode",
      "permission-profile-active",
      `当前使用 Permission Profile（${defaultPermissions}），不能同时写入传统 Sandbox 设置`,
    );
  }
  if (!sandboxModes.has(input.sandboxMode)) {
    throw invalid("sandboxMode", "invalid-sandbox", `Sandbox 无效：${String(input.sandboxMode)}`);
  }
  if (!approvalPolicies.has(input.approvalPolicy)) {
    throw invalid(
      "approvalPolicy",
      "invalid-approval-policy",
      `审批策略无效：${String(input.approvalPolicy)}`,
    );
  }
  if (typeof input.networkAccess !== "boolean") {
    throw invalid("networkAccess", "invalid-boolean", "网络权限必须是布尔值");
  }
  return {
    edits: [
      { keyPath: "sandbox_mode", value: input.sandboxMode },
      { keyPath: "approval_policy", value: input.approvalPolicy },
      {
        keyPath: "sandbox_workspace_write.network_access",
        value: input.networkAccess,
      },
    ],
    value: {
      sandboxMode: input.sandboxMode,
      approvalPolicy: input.approvalPolicy,
      networkAccess: input.networkAccess,
    },
  };
}

function assertOfficialDefaults(provider) {
  if (provider !== "openai") {
    throw invalid(
      "provider",
      "third-party-primary",
      `当前是第三方固定模式（${provider}）；模型和思考等级请在对应 Provider 设置中修改`,
    );
  }
}

function projectModel(model) {
  return {
    model: model.model,
    displayName: model.displayName,
    reasoningEfforts: model.supportedReasoningEfforts.map((option) => ({ ...option })),
    defaultReasoningEffort: model.defaultReasoningEffort,
    isDefault: model.isDefault,
  };
}

function isFastServiceTier(value) {
  if (value === null) return false;
  const normalized = value.toLowerCase();
  return normalized === "fast" || normalized === "priority";
}

function invalid(field, code, message, options) {
  return new CodexUserSettingsError(code, field, message, options);
}

function requiredString(value, field, label) {
  const normalized = optionalString(value);
  if (normalized === null) throw invalid(field, "required", `${label}不能为空`);
  return normalized;
}

function optionalString(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function record(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function configWriteErrorCode(error) {
  const data = record(record(error).data);
  return optionalString(data.config_write_error_code);
}
