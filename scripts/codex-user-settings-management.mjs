import { isDeepStrictEqual } from "node:util";

import { loadPrimaryModelProvider } from "../runtime/model-provider-runtime.mjs";
import { acceleratedServiceTierId } from "../runtime/service-tier.mjs";
import { areCodexUserConfigEditsApplied, createCodexUserConfigClient, readWithCodexUserConfigClient, withCodexUserConfigClient } from "./codex-user-config.mjs";
import { fingerprintManagementValue } from "./management-confirmations.mjs";
import { supportedPublicApprovalPolicies } from "./codex-public-cli-contract.mjs";
import { projectToolSettings, toolSettingEdits } from "./codex-tool-settings.mjs";

const sandboxModes = new Set(["read-only", "workspace-write"]);
const approvalPolicies = new Set(supportedPublicApprovalPolicies);
const approvalsReviewers = new Set(["user", "auto_review"]);
const webSearchModes = new Set(["live", "indexed", "cached", "disabled"]);
const reasoningSummaries = new Set(["auto", "concise", "detailed", "none"]);
const verbosities = new Set(["low", "medium", "high"]);
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
  signal,
} = {}) {
  const provider = primaryProvider(environment);
  return readWithCodexUserConfigClient(environment, createClient, signal, async (client) => {
    const [snapshot, models] = await Promise.all([
      client.readUserConfigSnapshot({ includeApprovalsReviewerPolicy: true, includeAcceleration: true }),
      provider === "openai" ? client.listModels().catch(() => null) : Promise.resolve(null),
    ]);
    return projectSettings(snapshot, provider, models);
  });
}

export async function updateCodexUserSetting(
  input,
  {
    environment = process.env,
    expectedVersion,
    expectedTargetFingerprint,
    createClient = createCodexUserConfigClient,
    primaryProvider = loadPrimaryModelProvider,
  } = {},
) {
  if (typeof expectedVersion !== "string" || expectedVersion.trim() === "") {
    throw invalid("revision", "required-revision", "必须提供有效的 Codex 用户配置修订值");
  }
  const provider = primaryProvider(environment);
  if (requiresOfficialModels(input) || input?.kind === "model-compact" || input?.kind === "service-tier") {
    assertOfficialDefaults(provider);
  }
  return withCodexUserConfigClient(environment, createClient, undefined, async (client) => {
    const [snapshot, models] = await Promise.all([
      client.readUserConfigSnapshot({ includeApprovalsReviewerPolicy: input?.kind === "approvals-reviewer", includeAcceleration: input?.kind === "all" || input?.kind === "service-tier" }),
      requiresOfficialModels(input)
        ? client.listModels()
        : Promise.resolve([]),
    ]);
    if (snapshot.version !== expectedVersion) {
      throw invalid("revision", "stale-revision", "Codex 用户配置已变化，请重新读取设置");
    }
    const { edits, result } = await planSettingChange(input, {
      config: snapshot.config,
      toolConfig: snapshot.toolConfig,
      approvalsReviewerPolicy: snapshot.approvalsReviewerPolicy,
      acceleration: snapshot.acceleration,
      provider,
      models,
    }, expectedVersion);
    if (expectedTargetFingerprint !== undefined && result.targetFingerprint !== expectedTargetFingerprint) {
      throw invalid("revision", "stale-revision", "工具合并配置已变化，请重新预览并确认");
    }
    if (edits.length === 0) return result;
    let written;
    try {
      written = await client.writeUserConfigEdits(edits, { expectedVersion });
    } catch (error) {
      const code = configWriteErrorCode(error);
      if (code === "configVersionConflict") {
        throw invalid(
          "revision",
          "stale-revision",
          "Codex 用户配置已变化，请重新读取设置",
          { cause: error },
        );
      }
      if (["configLayerReadonly", "configRequirementReadonly", "configValidationError"].includes(code)) {
        throw invalid("input", "unsupported-value", "Codex 拒绝本次配置修改：目标只读、受策略限制或配置无效；本次未写入，请重新读取后检查。", { cause: error });
      }
      // A lost response (or userLayerNotFound after persistence) cannot prove no write.
      throw invalid("input", "save-unconfirmed", "Codex 配置保存结果未确认，修改可能已写入；请先重新读取并核对，勿直接重复提交。", { cause: error });
    }
    const writeStatus = ["ok", "okOverridden"].includes(written?.status) ? written.status : null;
    const saved = { ...result, revision: null, consistency: "unknown", writeStatus };
    try {
      const current = await client.readUserConfigSnapshot();
      if (writeStatus !== null && typeof written.version === "string"
        && written.version === current.version && settingEditsApplied(current.config, edits, input)) {
        return { ...saved, revision: current.version, consistency: "confirmed" };
      }
    } catch {
      // The write already returned. Read failure never implies a failed save or replay.
    }
    return saved;
  }, { preserveOperationResult: true });
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
  if (requiresOfficialModels(input) || input?.kind === "model-compact" || input?.kind === "service-tier") {
    assertOfficialDefaults(provider);
  }
  return readWithCodexUserConfigClient(environment, createClient, undefined, async (client) => {
    const [snapshot, models] = await Promise.all([
      client.readUserConfigSnapshot({ includeApprovalsReviewerPolicy: input?.kind === "approvals-reviewer", includeAcceleration: input?.kind === "all" || input?.kind === "service-tier" }),
      requiresOfficialModels(input)
        ? client.listModels()
        : Promise.resolve([]),
    ]);
    if (snapshot.version !== expectedVersion) {
      throw invalid("revision", "stale-revision", "Codex 用户配置已变化，请重新读取设置");
    }
    const { result } = await planSettingChange(input, {
      config: snapshot.config,
      toolConfig: snapshot.toolConfig,
      approvalsReviewerPolicy: snapshot.approvalsReviewerPolicy,
      acceleration: snapshot.acceleration,
      provider,
      models,
    }, expectedVersion);
    return result;
  });
}

async function planSettingChange(input, context, previousVersion) {
  // Validate the full proposed setting, including effective tool policy, before
  // comparing user overrides. An inherited default is not a stored override.
  const { edits: proposed, value } = await createEdits(input, context);
  const edits = proposed.filter(edit => {
    // Tool keys may contain dots, quotes or backslashes; retain their original
    // segments rather than reparsing the encoded App Server key path.
    const path = input.kind === "tool-access" ? input.path : edit.keyPath.split(".");
    let current = context.config;
    for (const segment of path) {
      current = current !== null && typeof current === "object" && !Array.isArray(current)
        && Object.hasOwn(current, segment) ? current[segment] : undefined;
    }
    return edit.value === null ? current !== undefined : !isDeepStrictEqual(current, edit.value);
  });
  const willChange = edits.length > 0;
  return { edits, result: {
    kind: input.kind,
    previousVersion,
    value,
    action: willChange ? "updated" : "unchanged",
    willChange,
    activation: willChange ? codexUserSettingActivation(input.kind) : "none",
    revision: previousVersion,
    consistency: "confirmed",
    writeStatus: null,
    ...(input.kind === "tool-access" ? { targetFingerprint: toolTargetFingerprint(input.path, context.toolConfig) } : {}),
  } };
}

function requiresOfficialModels(input) {
  return ["all", "defaults"].includes(input?.kind)
    || (input?.kind === "service-tier" && input.serviceTier !== "default")
    || (input?.kind === "preferences" && Object.hasOwn(input, "planModeReasoningEffort")
      && input.planModeReasoningEffort !== null);
}

function settingEditsApplied(config, edits, input) {
  if (input.kind !== "tool-access") return areCodexUserConfigEditsApplied(config, edits);
  // Tool identifiers are opaque segments. The public helper only accepts plain
  // dot paths, while native encoded tool paths may include quoted dots/escapes.
  let current = config;
  for (const key of input.path) current = record(current)[key];
  return input.value === null ? current === undefined : isDeepStrictEqual(current, input.value);
}

function toolTargetFingerprint(path, merged) {
  if (merged === undefined) {
    throw invalid("path", "tool-target-unavailable", "无法确认工具合并目标，请重新读取设置");
  }
  // Hash the complete relevant transport/policy target; raw commands and credentials
  // remain inside the management boundary and never enter a preview response.
  const root = path[0] === "mcp_servers" ? ["mcp_servers", path[1]]
    : path[0] === "plugins" ? ["plugins", path[1]] : [path[0]];
  let target = merged;
  for (const key of root) target = record(target)[key];
  return fingerprintManagementValue({ root, target: target ?? null,
    ...(path[0] === "plugins" ? { defaultEnabled: record(record(merged.plugins)._default).enabled ?? null } : {}),
  });
}

function codexUserSettingActivation(kind) {
  if (kind === "auto-recap") return "next-tui";
  if (kind === "preferences" || kind === "all") return "next-thread-and-tui";
  return "next-thread";
}

function projectSettings(snapshot, provider, rawModels) {
  const config = record(snapshot.config);
  const modelsAvailable = rawModels !== null;
  const models = (rawModels ?? []).filter((model) => model.available !== false).map(projectModel);
  const configuredModel = optionalString(config.model);
  const configuredEffort = optionalString(config.model_reasoning_effort);
  const serviceTier = optionalString(config.service_tier);
  const webSearch = webSearchModes.has(config.web_search) ? config.web_search : null;
  const reasoningSummary = reasoningSummaries.has(config.model_reasoning_summary)
    ? config.model_reasoning_summary : null;
  const verbosity = verbosities.has(config.model_verbosity) ? config.model_verbosity : null;
  const history = record(config.history);
  const tools = record(config.tools);
  const updatePlan = record(tools.update_plan);
  const tui = record(config.tui);
  const configuredPlanEffort = optionalString(config.plan_mode_reasoning_effort);
  const planModeReasoningEffort = configuredPlanEffort;
  const sandboxMode = sandboxModes.has(config.sandbox_mode) ? config.sandbox_mode : null;
  const approvalPolicy = approvalPolicies.has(config.approval_policy)
    ? config.approval_policy
    : null;
  const workspaceSandbox = record(config.sandbox_workspace_write);
  return {
    version: snapshot.version,
    toolSettings: projectToolSettings(config, snapshot.toolConfig),
    provider,
    modelsAvailable,
    accelerationAvailable: snapshot.acceleration !== undefined,
    contextEditable: provider === "openai",
    defaultsEditable: provider === "openai" && modelsAvailable,
    approvalsReviewer: projectApprovalsReviewer(config, snapshot.approvalsReviewerPolicy),
    models,
    defaults: {
      configuredModel,
      model: configuredModel ?? models.find((model) => model.isDefault)?.model ?? null,
      reasoningEffort: configuredEffort,
      serviceTier,
      fastEnabled: snapshot.acceleration?.fastEnabled ?? false,
      ultrafastEnabled: snapshot.acceleration?.ultrafastEnabled ?? false,
      webSearch,
      updatePlanEnabled: typeof updatePlan.enabled === "boolean" ? updatePlan.enabled : null,
      autoRecapEnabled: typeof tui.auto_recap === "boolean" ? tui.auto_recap : null,
      reasoningSummary,
      planModeReasoningEffort,
      verbosity,
      checkForUpdateOnStartup: typeof config.check_for_update_on_startup === "boolean"
        ? config.check_for_update_on_startup : null,
      historyPersistence: historyPersistences.has(history.persistence) ? history.persistence : null,
      unsupportedFields: [
        ...(config.web_search != null && webSearch === null ? ["webSearch"] : []),
        ...(config.model_reasoning_summary != null && reasoningSummary === null ? ["reasoningSummary"] : []),
        ...(config.plan_mode_reasoning_effort != null && planModeReasoningEffort === null ? ["planModeReasoningEffort"] : []),
        ...(config.model_verbosity != null && verbosity === null ? ["verbosity"] : []),
        ...(history.persistence != null && !historyPersistences.has(history.persistence) ? ["historyPersistence"] : []),
        ...(updatePlan.enabled != null && typeof updatePlan.enabled !== "boolean" ? ["updatePlanEnabled"] : []),
        ...(tui.auto_recap != null && typeof tui.auto_recap !== "boolean" ? ["autoRecapEnabled"] : []),
        ...(config.check_for_update_on_startup != null && typeof config.check_for_update_on_startup !== "boolean" ? ["checkForUpdateOnStartup"] : []),
      ],
    },
    permissions: {
      editable: optionalString(config.default_permissions) === null,
      defaultPermissions: optionalString(config.default_permissions),
      unsupportedFields: [
        ...(config.sandbox_mode != null && sandboxMode === null ? ["sandboxMode"] : []),
        ...(config.approval_policy != null && approvalPolicy === null ? ["approvalPolicy"] : []),
        ...(workspaceSandbox.network_access != null && typeof workspaceSandbox.network_access !== "boolean" ? ["networkAccess"] : []),
      ],
      sandboxMode,
      approvalPolicy,
      networkAccess: typeof workspaceSandbox.network_access === "boolean"
        ? workspaceSandbox.network_access
        : null,
    },
    compact: {
      contextWindow: optionalSafeInteger(config.model_context_window, "contextWindow"),
      autoCompactTokenLimit: optionalSafeInteger(config.model_auto_compact_token_limit, "autoCompactTokenLimit"),
    },
  };
}

function createEdits(input, { config, toolConfig, approvalsReviewerPolicy, acceleration, provider, models }) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw invalid("input", "invalid-input", "Codex 用户设置输入必须是对象");
  }
  switch (input.kind) {
    case "tool-access":
      return toolSettingEdits(input, config, toolConfig, invalid);
    case "all":
      return allEdits(input, provider, config, models, acceleration);
    case "defaults":
      return defaultEdits(input, provider, models);
    case "service-tier":
      assertOfficialDefaults(provider);
      return serviceTierEdit(input.serviceTier, config, models, acceleration);
    case "permissions":
      return permissionEdits(input, config, true);
    case "approvals-reviewer":
      return approvalsReviewerEdits(input, config, approvalsReviewerPolicy);
    case "web-search":
      return webSearchEdits(input);
    case "update-plan":
      return updatePlanEdits(input);
    case "auto-recap":
      return autoRecapEdits(input);
    case "model-compact":
      return modelCompactEdits(input);
    case "preferences":
      return preferenceEdits(input, models);
    default:
      throw invalid("kind", "unknown-setting", `未知 Codex 用户设置：${String(input.kind)}`);
  }
}

function projectApprovalsReviewer(config, policy) {
  const configured = record(config).approvals_reviewer;
  const value = approvalsReviewers.has(configured) ? configured : null;
  if (configured !== undefined && !approvalsReviewers.has(configured)) {
    return { value, editable: false, reason: "unsupported-value" };
  }
  if (!policy || typeof policy.autoReviewDisabled !== "boolean"
    || (policy.allowedReviewers !== null && (!Array.isArray(policy.allowedReviewers)
      || policy.allowedReviewers.some((reviewer) => !approvalsReviewers.has(reviewer))))) {
    return { value, editable: false, reason: "unavailable" };
  }
  if (policy.autoReviewDisabled || (policy.allowedReviewers !== null
    && ![...approvalsReviewers].every((reviewer) => policy.allowedReviewers.includes(reviewer)))) {
    return { value, editable: false, reason: "managed-policy" };
  }
  return { value, editable: true };
}

function approvalsReviewerEdits(input, config, policy) {
  if (!approvalsReviewers.has(input.value)) {
    throw invalid("value", "invalid-approvals-reviewer", "审批审核人必须是 user 或 auto_review");
  }
  const current = projectApprovalsReviewer(config, policy);
  if (!current.editable) {
    throw invalid("value", `approvals-reviewer-${current.reason}`, "当前 Auto-review 设置不可修改，请检查 Codex 配置与组织策略");
  }
  return {
    edits: [{ keyPath: "approvals_reviewer", value: input.value }],
    value: { value: input.value },
  };
}

function allEdits(input, provider, config, models, acceleration) {
  assertOfficialDefaults(provider);
  const defaults = defaultEdits(input, provider, models);
  const tier = serviceTierEdit(input.serviceTier, config, models, acceleration, defaults.value.model);
  if (input.permissions === null && optionalString(record(config).default_permissions) === null) {
    throw invalid("permissions", "missing-permissions", "未使用 Permission Profile，必须明确选择权限默认值");
  }
  const permissions = input.permissions === null ? { edits: [], value: {} } : permissionEdits(input.permissions ?? {}, config);
  const preferences = preferenceEdits(input, models);
  return {
    edits: [...defaults.edits, ...tier.edits, ...permissions.edits, ...preferences.edits],
    value: {
      ...defaults.value,
      serviceTier: tier.value.serviceTier,
      ...permissions.value,
      ...preferences.value,
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

function autoRecapEdits(input) {
  if (typeof input?.enabled !== "boolean") {
    throw invalid("enabled", "invalid-boolean", "空闲总结状态必须是布尔值");
  }
  return {
    edits: [{ keyPath: "tui.auto_recap", value: input.enabled }],
    value: { enabled: input.enabled },
  };
}

function preferenceEdits(input, models) {
  if (Object.hasOwn(input, "personality")) {
    throw invalid("personality", "unsupported-field", "当前 Codex 已停用模型人格设置");
  }
  const fields = [
    ["reasoningSummary", "model_reasoning_summary", reasoningSummaries],
    ["planModeReasoningEffort", "plan_mode_reasoning_effort", null],
    ["verbosity", "model_verbosity", verbosities],
    ["checkForUpdateOnStartup", "check_for_update_on_startup", null],
    ["historyPersistence", "history.persistence", historyPersistences],
  ];
  if (input.kind === "preferences" && Object.keys(input).some(key => key !== "kind"
    && !fields.some(([field]) => field === key))) {
    throw invalid("input", "unsupported-field", "用户偏好包含不支持的字段");
  }
  const selected = fields.filter(([field]) => input.kind === "all" || Object.hasOwn(input, field));
  if (selected.length === 0) {
    throw invalid("input", "invalid-input", "请至少选择一项用户偏好");
  }
  const edits = [];
  const value = {};
  for (const [field, keyPath, allowed] of selected) {
    let candidate = input[field];
    if (candidate !== null) {
      if (allowed !== null && !allowed.has(candidate)) {
        throw invalid(field, `invalid-${field}`, `用户偏好无效：${String(candidate)}`);
      }
      if (field === "checkForUpdateOnStartup" && typeof candidate !== "boolean") {
        throw invalid(field, "invalid-boolean", "启动更新检查必须是布尔值");
      }
      if (field === "planModeReasoningEffort") {
        const effort = requiredString(candidate, field, "Plan 思考等级");
        if (!models.some(model => model.available !== false
          && model.supportedReasoningEfforts.some(option => option.effort === effort))) {
          throw invalid(field, "invalid-reasoning-effort", `Plan 思考等级不可用：${effort}`);
        }
        candidate = effort;
      }
    }
    edits.push({ keyPath, value: candidate });
    value[field] = candidate;
  }
  return { edits, value };
}

function modelCompactEdits(input) {
  if (Object.keys(input).some((key) => !["kind", "contextWindow", "autoCompactTokenLimit"].includes(key))) {
    throw invalid("input", "invalid-input", "模型上下文与自动压缩仅接受上下文窗口和精确 Token 阈值");
  }
  const { contextWindow, autoCompactTokenLimit } = input;
  if (
    contextWindow !== null
    && (!Number.isSafeInteger(contextWindow) || contextWindow <= 0)
  ) {
    throw invalid("contextWindow", "invalid-window", "模型上下文窗口必须是正整数");
  }
  if (
    autoCompactTokenLimit !== null
    && (!Number.isSafeInteger(autoCompactTokenLimit) || autoCompactTokenLimit <= 0)
  ) {
    throw invalid("autoCompactTokenLimit", "invalid-token-limit", "自动压缩阈值必须是正整数");
  }
  return {
    edits: [
      { keyPath: "model_context_window", value: contextWindow },
      { keyPath: "model_auto_compact_token_limit", value: autoCompactTokenLimit },
    ],
    value: { contextWindow, autoCompactTokenLimit },
  };
}

function accelerationFlags(value) {
  if (typeof value?.fastEnabled !== "boolean" || typeof value?.ultrafastEnabled !== "boolean") {
    throw invalid("serviceTier", "acceleration-unavailable", "无法确认 Codex 的加速开关和策略，请重新读取设置");
  }
  return { fastEnabled: value.fastEnabled, ultrafastEnabled: value.ultrafastEnabled };
}

function serviceTierEdit(serviceTier, config, models, acceleration, selectedModel = optionalString(config.model)) {
  if (!["default", "fast", "ultrafast"].includes(serviceTier)) {
    throw invalid("serviceTier", "invalid-service-tier", "加速档位必须是 default、fast 或 ultrafast");
  }
  if (serviceTier !== "default") {
    const flags = accelerationFlags(acceleration);
    if (!(serviceTier === "ultrafast" ? flags.ultrafastEnabled : flags.fastEnabled)) {
      throw invalid("serviceTier", "acceleration-disabled", `Codex ${serviceTier === "ultrafast" ? "Ultrafast" : "Fast"} 已关闭或受策略限制，不能启用该档位`);
    }
    const model = selectedModel === null
      ? models.find((candidate) => candidate.isDefault && candidate.available !== false)
      : models.find((candidate) => candidate.model === selectedModel && candidate.available !== false);
    if (!model) {
      throw invalid("model", "unknown-model", `默认模型不可用：${selectedModel ?? "未指定"}；请先选择有效模型`);
    }
    const supported = acceleratedServiceTierId(model.serviceTiers, serviceTier);
    if (!supported) {
      throw invalid("serviceTier", "unsupported-service-tier", `模型 ${model.model} 不支持 ${serviceTier === "fast" ? "Fast" : "Ultrafast"}`);
    }
  }
  return {
    edits: [{ keyPath: "service_tier", value: serviceTier }],
    value: { serviceTier },
  };
}

function permissionEdits(input, config, partial = false) {
  const defaultPermissions = optionalString(record(config).default_permissions);
  if (defaultPermissions !== null) {
    throw invalid(
      "sandboxMode",
      "permission-profile-active",
      `当前使用 Permission Profile（${defaultPermissions}），不能同时写入传统 Sandbox 设置`,
    );
  }
  const keys = ["sandboxMode", "approvalPolicy", "networkAccess"];
  if (!input || typeof input !== "object" || Array.isArray(input)
    || Object.keys(input).some(key => !keys.includes(key) && !(partial && key === "kind"))) {
    throw invalid("permissions", "invalid-input", "权限设置包含不支持的字段");
  }
  const fields = keys.filter(key => Object.hasOwn(input, key));
  if (fields.length === 0 || !partial && fields.length !== keys.length) {
    throw invalid("permissions", "missing-permissions", partial ? "请选择至少一项权限设置" : "批量配置必须明确选择完整权限默认值");
  }
  if (fields.includes("sandboxMode") && !sandboxModes.has(input.sandboxMode)) {
    throw invalid("sandboxMode", "invalid-sandbox", `Sandbox 无效：${String(input.sandboxMode)}`);
  }
  if (fields.includes("approvalPolicy") && !approvalPolicies.has(input.approvalPolicy)) {
    throw invalid(
      "approvalPolicy",
      "invalid-approval-policy",
      `审批策略无效：${String(input.approvalPolicy)}`,
    );
  }
  if (fields.includes("networkAccess") && typeof input.networkAccess !== "boolean") {
    throw invalid("networkAccess", "invalid-boolean", "网络权限必须是布尔值");
  }
  const paths = { sandboxMode: "sandbox_mode", approvalPolicy: "approval_policy", networkAccess: "sandbox_workspace_write.network_access" };
  return {
    edits: fields.map(field => ({ keyPath: paths[field], value: input[field] })),
    value: Object.fromEntries(fields.map(field => [field, input[field]])),
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
    serviceTiers: model.serviceTiers.map((tier) => ({ ...tier })),
    isDefault: model.isDefault,
  };
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

function optionalSafeInteger(value, field) {
  if (value === null || value === undefined) return null;
  const normalized = typeof value === "bigint"
    ? Number(value)
    : typeof value === "string"
      ? Number(value)
      : value;
  if (!Number.isSafeInteger(normalized) || normalized <= 0) {
    throw invalid(field, "unsupported-value", "当前上下文或压缩配置无法安全表示为正整数，请先在原生 Codex 配置中调整");
  }
  return normalized;
}

function record(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function configWriteErrorCode(error) {
  const data = record(record(error).data);
  return optionalString(data.config_write_error_code);
}
