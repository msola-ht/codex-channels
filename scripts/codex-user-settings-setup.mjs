import * as clackPrompts from "@clack/prompts";

import { runCodexDefaultsSetup } from "./codex-defaults-setup.mjs";
import {
  loadCodexUserSettings,
  updateCodexUserSetting,
} from "./codex-user-settings-management.mjs";

const reasoningSummaryLabels = { auto: "自动", concise: "简洁", detailed: "详细", none: "关闭" };
const verbosityLabels = { low: "简短", medium: "适中", high: "详细" };
const personalityLabels = { none: "默认", friendly: "友好", pragmatic: "务实" };
const historyPersistenceLabels = { "save-all": "保存", none: "不保存" };
const reasoningSummaryHints = { auto: "由 Codex 自动选择摘要方式", concise: "优先压缩为简短摘要", detailed: "保留更多推理摘要内容", none: "不生成推理摘要" };
const verbosityHints = { low: "回复更简洁", medium: "在简洁和细节之间平衡", high: "提供更完整的解释" };
const personalityHints = { none: "使用 Codex 默认人格", friendly: "语气更友好自然", pragmatic: "更直接、注重执行" };
const historyPersistenceHints = { "save-all": "保存会话历史，便于恢复和接续", none: "不保存新的会话历史" };

export async function runCodexUserSettingsSetup({
  environment = process.env,
  output = process.stdout,
  prompts = clackPrompts,
  defaultsSetup = runCodexDefaultsSetup,
  loadSettings = loadCodexUserSettings,
  updateSetting = updateCodexUserSetting,
  createClient,
  primaryProvider,
} = {}) {
  const settings = await loadSettings({ environment, createClient, primaryProvider });
  const section = await prompts.select({
    message: "选择 Codex 用户设置",
    showInstructions: false,
    options: [
      ...(settings.defaultsEditable && settings.permissions.editable
        ? [{
            value: "all",
            label: "一键配置全部",
            hint: "一次选择并原子写入全部用户默认值",
          }]
        : []),
      ...(settings.defaultsEditable
        ? [{
            value: "defaults",
            label: "默认模型与思考等级",
            hint: `${settings.defaults.model ?? "跟随官方默认"} · ${settings.defaults.reasoningEffort ?? "跟随模型默认"}`,
          }]
        : []),
      {
        value: "fast",
        label: "Fast 默认状态",
        hint: settings.defaults.fastEnabled ? "当前：开启" : "当前：关闭",
      },
      {
        value: "web-search",
        label: "联网搜索模式",
        hint: settings.defaults.webSearch ?? "当前：未设置（默认缓存）",
      },
      ...(settings.defaultsEditable ? [{
        value: "preferences",
        label: "其他用户偏好",
        hint: "Plan、推理摘要、输出详细程度、人格、更新检查与历史",
      }] : []),
      {
        value: "permissions",
        label: "沙盒、审批与网络",
        hint: permissionHint(settings.permissions),
      },
      { value: "back", label: "返回", hint: "返回设置类别" },
    ],
  });
  if (prompts.isCancel(section) || section === "back") return { action: "back" };
  if (section === "all") {
    return runAllSettings({
      environment,
      output,
      prompts,
      settings,
      updateSetting,
      createClient,
      primaryProvider,
    });
  }
  if (section === "defaults") {
    return defaultsSetup({
      environment,
      output,
      prompts,
      allowBack: true,
      ...(createClient === undefined ? {} : { createClient }),
      ...(primaryProvider === undefined ? {} : { primaryProvider }),
      loadSettings,
      updateSetting,
    });
  }
  if (section === "fast") {
    return runFastSetting({
      environment,
      output,
      prompts,
      settings,
      updateSetting,
      createClient,
      primaryProvider,
    });
  }
  if (section === "web-search") {
    return runWebSearchSetting({
      environment,
      output,
      prompts,
      settings,
      updateSetting,
      createClient,
      primaryProvider,
    });
  }
  if (section === "preferences") {
    return runPreferencesSetting({ environment, output, prompts, settings, updateSetting, createClient, primaryProvider });
  }
  if (section === "permissions") {
    return runPermissionSettings({
      environment,
      output,
      prompts,
      settings,
      updateSetting,
      createClient,
      primaryProvider,
    });
  }
  throw new Error(`未知 Codex 用户设置：${String(section)}`);
}

async function runAllSettings({
  environment,
  output,
  prompts,
  settings,
  updateSetting,
  createClient,
  primaryProvider,
}) {
  if (!settings.defaultsEditable || !settings.permissions.editable) {
    output.write("当前配置不能使用一键写入全部，请分别检查 Provider 与 Permission Profile。\n");
    return { action: "back" };
  }
  const modelDefaults = await promptModelDefaults(prompts, settings);
  if (modelDefaults === null) return { action: "back" };
  const fastEnabled = await promptFast(prompts, settings.defaults.fastEnabled);
  if (fastEnabled === null) return { action: "back" };
  const permissions = await promptPermissions(prompts, settings);
  if (permissions === null) return { action: "back" };
  const confirmed = await prompts.confirm({
    message: [
      "一次写入全部 Codex 用户设置：",
      `${modelDefaults.model.model} · ${modelDefaults.reasoningEffort}`,
      `Fast ${fastEnabled ? "开启" : "关闭"}`,
      `${permissions.sandboxMode} · ${permissions.approvalPolicy}`,
      `网络${permissions.networkAccess ? "开启" : "关闭"}`,
      "联网搜索：缓存？",
      "分析关闭",
      "反馈关闭",
      "Goals 开启？",
    ].join(" · "),
    initialValue: true,
  });
  if (prompts.isCancel(confirmed) || confirmed !== true) {
    output.write("已取消，未修改 Codex 用户设置。\n");
    return undefined;
  }
  const result = await updateSetting({
    kind: "all",
    model: modelDefaults.model.model,
    reasoningEffort: modelDefaults.reasoningEffort,
    fastEnabled,
    ...permissions,
  }, {
    environment,
    expectedVersion: settings.version,
    ...(createClient === undefined ? {} : { createClient }),
    ...(primaryProvider === undefined ? {} : { primaryProvider }),
  });
  output.write(
    `Codex 用户设置已全部更新：${modelDefaults.model.model} · ${modelDefaults.reasoningEffort} · Fast ${fastEnabled ? "开启" : "关闭"} · ${permissions.sandboxMode} · ${permissions.approvalPolicy} · 网络${permissions.networkAccess ? "开启" : "关闭"} · 联网搜索缓存 · 分析关闭 · 反馈关闭 · Goals 开启\n`,
  );
  output.write("请运行 codexc service restart all，使 App Server 新会话使用新默认值。\n");
  return result;
}

async function runFastSetting({
  environment,
  output,
  prompts,
  settings,
  updateSetting,
  createClient,
  primaryProvider,
}) {
  const enabled = await promptFast(prompts, settings.defaults.fastEnabled);
  if (enabled === null) return { action: "back" };
  const result = await updateSetting({ kind: "fast", enabled }, {
    environment,
    expectedVersion: settings.version,
    ...(createClient === undefined ? {} : { createClient }),
    ...(primaryProvider === undefined ? {} : { primaryProvider }),
  });
  output.write(`Codex 新会话默认 Fast 已${enabled ? "开启" : "关闭"}。\n`);
  output.write("请运行 codexc service restart all，使 App Server 新会话使用新默认值。\n");
  return result;
}

async function runWebSearchSetting({
  environment,
  output,
  prompts,
  settings,
  updateSetting,
  createClient,
  primaryProvider,
}) {
  const mode = await prompts.select({
    message: "选择联网搜索模式",
    showInstructions: false,
    initialValue: settings.defaults.webSearch ?? "cached",
    options: [
      { value: "cached", label: "缓存", hint: "使用 Codex 缓存搜索结果" },
      { value: "live", label: "实时", hint: "执行实时联网搜索" },
      { value: "indexed", label: "索引", hint: "使用索引搜索" },
      { value: "disabled", label: "关闭", hint: "禁用联网搜索" },
      { value: "back", label: "返回" },
    ],
  });
  if (prompts.isCancel(mode) || mode === "back") return { action: "back" };
  const confirmed = await prompts.confirm({
    message: `保存联网搜索模式：${mode}？`,
    initialValue: true,
  });
  if (prompts.isCancel(confirmed) || confirmed !== true) {
    output.write("已取消，未修改联网搜索设置。\n");
    return undefined;
  }
  const result = await updateSetting({ kind: "web-search", mode }, {
    environment,
    expectedVersion: settings.version,
    ...(createClient === undefined ? {} : { createClient }),
    ...(primaryProvider === undefined ? {} : { primaryProvider }),
  });
  output.write(`Codex 联网搜索模式已更新：${mode}\n`);
  output.write("请运行 codexc service restart all，使新会话使用新设置。\n");
  return result;
}

async function runPreferencesSetting({ environment, output, prompts, settings, updateSetting, createClient, primaryProvider }) {
  const preferences = await promptPreferences(prompts, settings);
  if (preferences === null) return { action: "back" };
  const confirmed = await prompts.confirm({ message: `保存其他用户偏好：Plan 思考等级 ${preferences.planModeReasoningEffort} · 摘要 ${reasoningSummaryLabels[preferences.reasoningSummary]} · 输出详细程度 ${verbosityLabels[preferences.verbosity]} · 人格 ${personalityLabels[preferences.personality]} · 更新检查 ${preferences.checkForUpdateOnStartup ? "开启" : "关闭"} · 历史记录 ${historyPersistenceLabels[preferences.historyPersistence]}？`, initialValue: true });
  if (prompts.isCancel(confirmed) || confirmed !== true) { output.write("已取消，未修改其他用户偏好。\n"); return undefined; }
  const result = await updateSetting({ kind: "preferences", ...preferences }, { environment, expectedVersion: settings.version, ...(createClient === undefined ? {} : { createClient }), ...(primaryProvider === undefined ? {} : { primaryProvider }) });
  output.write("Codex 其他用户偏好已更新。\n");
  output.write("请运行 codexc service restart all，使新会话使用新设置。\n");
  return result;
}

async function promptPreferences(prompts, settings) {
  const pick = async (message, initialValue, options) => {
    const value = await prompts.select({ message, showInstructions: false, initialValue, options: [...options, { value: "back", label: "返回" }] });
    return prompts.isCancel(value) || value === "back" ? null : value;
  };
  const model = settings.models.find((item) => item.model === settings.defaults.model) ?? settings.models[0];
  if (!model || model.reasoningEfforts.length === 0) throw new Error("当前没有可用模型思考等级");
  const planModeReasoningEffort = await pick("Plan 默认思考等级", settings.defaults.planModeReasoningEffort ?? model.defaultReasoningEffort, model.reasoningEfforts.map((item) => ({ value: item.effort, label: item.effort, hint: item.description })));
  if (planModeReasoningEffort === null) return null;
  const reasoningSummary = await pick("推理摘要", settings.defaults.reasoningSummary ?? "auto", Object.entries(reasoningSummaryLabels).map(([value, label]) => ({ value, label, hint: reasoningSummaryHints[value] })));
  if (reasoningSummary === null) return null;
  const verbosity = await pick("输出详细程度", settings.defaults.verbosity ?? "medium", Object.entries(verbosityLabels).map(([value, label]) => ({ value, label, hint: verbosityHints[value] })));
  if (verbosity === null) return null;
  const personality = await pick("模型人格", settings.defaults.personality ?? "none", Object.entries(personalityLabels).map(([value, label]) => ({ value, label, hint: personalityHints[value] })));
  if (personality === null) return null;
  const checkForUpdateOnStartup = await pick("启动时检查更新", settings.defaults.checkForUpdateOnStartup ?? true, [{ value: true, label: "开启" }, { value: false, label: "关闭" }]);
  if (checkForUpdateOnStartup === null) return null;
  const historyPersistence = await pick("历史记录保存", settings.defaults.historyPersistence ?? "save-all", Object.entries(historyPersistenceLabels).map(([value, label]) => ({ value, label, hint: historyPersistenceHints[value] })));
  if (historyPersistence === null) return null;
  return { reasoningSummary, planModeReasoningEffort, verbosity, personality, checkForUpdateOnStartup, historyPersistence };
}

async function runPermissionSettings({
  environment,
  output,
  prompts,
  settings,
  updateSetting,
  createClient,
  primaryProvider,
}) {
  if (!settings.permissions.editable) {
    output.write(
      `当前使用 Permission Profile（${settings.permissions.defaultPermissions}），本入口未修改配置。\n`,
    );
    return { action: "back" };
  }
  const permissions = await promptPermissions(prompts, settings);
  if (permissions === null) return { action: "back" };
  const { sandboxMode, approvalPolicy, networkAccess } = permissions;
  const confirmed = await prompts.confirm({
    message: `保存用户权限默认值：${sandboxMode} · ${approvalPolicy} · 网络${networkAccess ? "开启" : "关闭"}？`,
    initialValue: true,
  });
  if (prompts.isCancel(confirmed) || confirmed !== true) {
    output.write("已取消，未修改 Codex 用户权限设置。\n");
    return undefined;
  }
  const result = await updateSetting({
    kind: "permissions",
    sandboxMode,
    approvalPolicy,
    networkAccess,
  }, {
    environment,
    expectedVersion: settings.version,
    ...(createClient === undefined ? {} : { createClient }),
    ...(primaryProvider === undefined ? {} : { primaryProvider }),
  });
  output.write(
    `Codex 用户权限已更新：${sandboxMode} · ${approvalPolicy} · 网络${networkAccess ? "开启" : "关闭"}\n`,
  );
  output.write("请运行 codexc service restart all，使 App Server 新会话使用新默认值。\n");
  return result;
}

async function promptModelDefaults(prompts, settings) {
  const fallback = settings.models.find((model) => model.model === settings.defaults.model)
    ?? settings.models.find((model) => model.isDefault)
    ?? settings.models[0];
  if (!fallback) throw new Error("Codex App Server 没有返回可用的官方模型");
  const selectedModel = await prompts.select({
    message: "选择 Codex 全局默认模型",
    showInstructions: false,
    initialValue: fallback.model,
    options: [
      ...settings.models.map((model) => ({
        value: model.model,
        label: model.displayName,
        hint: model.model,
      })),
      { value: "back", label: "返回" },
    ],
  });
  if (prompts.isCancel(selectedModel) || selectedModel === "back") return null;
  const model = settings.models.find((candidate) => candidate.model === selectedModel);
  if (!model) throw new Error("选择的 Codex 官方模型已经不可用");
  if (model.reasoningEfforts.length === 0) {
    throw new Error(`Codex 模型没有返回可用思考等级：${model.model}`);
  }
  const currentEffort = model.model === settings.defaults.model
    && model.reasoningEfforts.some(
      (option) => option.effort === settings.defaults.reasoningEffort,
    )
    ? settings.defaults.reasoningEffort
    : model.defaultReasoningEffort;
  const reasoningEffort = await prompts.select({
    message: `选择 ${model.displayName} 的全局默认思考等级`,
    showInstructions: false,
    initialValue: currentEffort,
    options: [
      ...model.reasoningEfforts.map((option) => ({
        value: option.effort,
        label: option.effort,
        hint: option.description,
      })),
      { value: "back", label: "返回" },
    ],
  });
  if (prompts.isCancel(reasoningEffort) || reasoningEffort === "back") return null;
  return { model, reasoningEffort };
}

async function promptFast(prompts, initialValue) {
  const enabled = await prompts.select({
    message: "新会话默认 Fast 状态",
    showInstructions: false,
    initialValue,
    options: [
      { value: true, label: "开启", hint: "新会话默认使用 Fast" },
      { value: false, label: "关闭", hint: "新会话默认使用标准服务层级" },
      { value: "back", label: "返回" },
    ],
  });
  return prompts.isCancel(enabled) || enabled === "back" ? null : enabled;
}

async function promptPermissions(prompts, settings) {
  const sandboxMode = await prompts.select({
    message: "默认 Sandbox",
    showInstructions: false,
    initialValue: settings.permissions.sandboxMode ?? "workspace-write",
    options: [
      { value: "workspace-write", label: "工作区可写", hint: "允许修改当前工作区" },
      { value: "read-only", label: "只读", hint: "禁止工作区写入" },
      { value: "back", label: "返回" },
    ],
  });
  if (prompts.isCancel(sandboxMode) || sandboxMode === "back") return null;
  const approvalPolicy = await prompts.select({
    message: "默认审批策略",
    showInstructions: false,
    initialValue: settings.permissions.approvalPolicy ?? "on-request",
    options: [
      { value: "on-request", label: "按需审批", hint: "需要额外权限时询问" },
      { value: "untrusted", label: "严格审批", hint: "不受信命令先询问" },
      { value: "never", label: "不请求审批", hint: "无法在运行中申请额外权限" },
      { value: "back", label: "返回" },
    ],
  });
  if (prompts.isCancel(approvalPolicy) || approvalPolicy === "back") {
    return null;
  }
  const networkAccess = await prompts.select({
    message: "Workspace Sandbox 网络权限",
    showInstructions: false,
    initialValue: settings.permissions.networkAccess ?? false,
    options: [
      { value: false, label: "关闭", hint: "默认禁止沙盒直接访问网络" },
      { value: true, label: "开启", hint: "允许 workspace-write 沙盒访问网络" },
      { value: "back", label: "返回" },
    ],
  });
  if (prompts.isCancel(networkAccess) || networkAccess === "back") {
    return null;
  }
  return { sandboxMode, approvalPolicy, networkAccess };
}

function permissionHint(permissions) {
  if (!permissions.editable) return `当前使用 Permission Profile：${permissions.defaultPermissions}`;
  return [
    permissions.sandboxMode ?? "未显式设置 Sandbox",
    permissions.approvalPolicy ?? "未显式设置审批",
    `网络${permissions.networkAccess === true ? "开启" : "关闭"}`,
  ].join(" · ");
}
