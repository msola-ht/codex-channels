import { writeGatewayConfig } from "../runtime/gateway-config.mjs";
import { validateModelDisplayAliases } from "../runtime/model-display-name.mjs";
import { loadManagedModelProviderSettings } from "../runtime/model-provider-runtime.mjs";
import { messageDisplayPresets } from "../runtime/message-display-policy.mjs";
import { writeGatewayConfigActivationNotice } from "./config-activation-notice.mjs";
import {
  loadGatewaySettings,
  updateGatewaySetting,
} from "./config-management.mjs";

export async function runDisplaySettings({
  environment,
  output,
  prompts,
  telegramConfigured = false,
  writeConfig = writeGatewayConfig,
}) {
  while (true) {
    const section = await prompts.select({
      message: "选择显示设置",
      showInstructions: false,
      options: [
        { value: "preset", label: "应用显示预设", hint: "静默 / 紧凑 / 详细 / 完整，一次设置全局九项显示字段" },
        { value: "scope", label: "范围显示覆盖", hint: "渠道、账号、聊天类型与已确认聊天；逐字段继承" },
        { value: "completion", label: "完成通知", hint: "关闭成功通知 / 精简 / 详细，缺省详细" },
        { value: "presentation_detail", label: "消息详情", hint: "基础 / 详细 / 完整，独立于日志等级，缺省基础" },
        { value: "subagents", label: "子代理显示", hint: "开启 / 关闭，缺省开启" },
        { value: "streaming", label: "流式显示", hint: "正文增量预览，缺省开启；仅 Telegram、飞书和 QQ 单聊" },
        { value: "commentary", label: "过程说明", hint: "commentary 过程说明，缺省开启；Telegram、飞书和 QQ" },
        { value: "routine_notifications", label: "常规通知", hint: "常规生命周期与成功提示，四渠道缺省开启" },
        { value: "operation_updates", label: "操作详情显示", hint: "full / detailed / compact / failures / hidden" },
        { value: "plan_updates", label: "计划更新显示", hint: "是否显示 Codex 计划" },
        { value: "reasoning", label: "思考状态显示", hint: "默认关闭；是否显示“思考中”状态卡" },
        { value: "model_aliases", label: "模型统计分组", hint: "仅合并控制台按模型统计，保留原始模型明细" },
        ...(telegramConfigured ? [{ value: "message_format", label: "Telegram 消息格式", hint: "HTML 或富文本" }] : []),
        { value: "back", label: "返回", hint: "返回配置菜单" },
      ],
    });
    if (prompts.isCancel(section) || section === "back") return { action: "back" };
    let result;
    const options = { environment, output, prompts, writeConfig };
    if (section === "preset") {
      result = await runDisplayPresetSettings(options);
    } else if (section === "scope") {
      result = await runDisplayScopeSettings(options);
    } else if (section === "completion") {
      result = await runCompletionSettings(options);
    } else if (section === "presentation_detail") {
      result = await runPresentationDetailSettings(options);
    } else if (section === "subagents") {
      result = await runSubagentsSettings(options);
    } else if (section === "streaming") {
      result = await runStreamingSettings(options);
    } else if (section === "commentary") {
      result = await runCommentarySettings(options);
    } else if (section === "routine_notifications") {
      result = await runRoutineNotificationsSettings(options);
    } else if (section === "message_format" && telegramConfigured) {
      result = await runTelegramMessageFormat(options);
    } else if (section === "operation_updates") {
      result = await runOperationUpdatesToggle(options);
    } else if (section === "plan_updates") {
      result = await runPlanUpdatesToggle(options);
    } else if (section === "reasoning") {
      result = await runReasoningToggle(options);
    } else if (section === "model_aliases") {
      result = await runModelDisplayGroups(options);
    } else {
      throw new Error(`未知显示设置：${String(section)}`);
    }
    if (result?.action === "back") continue;
    return result;
  }
}

async function runDisplayScopeSettings({ environment, output, prompts, writeConfig }) {
  const settings = loadGatewaySettings(environment);
  output.write("范围显示按全局 → 渠道 → 账号 → 聊天类型 → 指定聊天逐字段继承；微信支持常规通知、完成通知和消息详情，QQ 群不支持流式显示。\n");
  if (settings.display.targetsStatus === "unavailable") output.write("已确认聊天目标不可读，请检查状态库版本、结构或访问权限；渠道与账号默认仍可编辑。\n");
  const label = scope => [scope.selector.surface, scope.selector.account_id, scope.selector.chat_kind === "direct" ? "私聊" : scope.selector.chat_kind === "group" ? "群聊" : undefined, scope.selector.chat_id].filter(Boolean).join(" / ");
  const selected = await prompts.select({ message: "选择显示目标范围", showInstructions: false, options: [
    ...settings.display.scopes.map((scope, index) => ({ value: String(index), label: label(scope), hint: scope.writable ? "可设置或恢复继承" : "已停用或移除，仅可恢复继承" })),
    { value: "back", label: "返回上一级" },
  ] });
  if (prompts.isCancel(selected) || selected === "back") return { action: "back" };
  const scope = settings.display.scopes[Number(selected)];
  if (!scope) throw new Error("未知显示目标范围");
  output.write(`当前目标：${label(scope)}\n${displayScopeSummary(scope)}\n`);
  const field = await prompts.select({ message: "选择显示字段", showInstructions: false, options: [
    ...(scope.writable ? [{ value: "preset", label: "应用显示预设", hint: "一次设置本层全部支持字段" }] : []),
    ...[{ value: "operation_updates", label: "操作详情" }, { value: "subagents", label: "子代理显示" }, { value: "streaming", label: "流式显示" }, { value: "commentary", label: "过程说明" }, { value: "routine_notifications", label: "常规通知" }, { value: "plan_updates", label: "计划更新" }, { value: "reasoning", label: "思考状态" }, { value: "completion", label: "完成通知" }, { value: "presentation_detail", label: "消息详情" }].filter(option => scope.supportedFields.includes(option.value)), { value: "back", label: "返回上一级" },
  ] });
  if (prompts.isCancel(field) || field === "back") return { action: "back" };
  if (field === "preset" && scope.writable) return runDisplayPresetSettings({ environment, output, prompts, writeConfig, settings, scope });
  if (!scope.supportedFields.includes(field)) throw new Error("该目标不支持所选显示字段");
  const value = await prompts.select({ message: "选择本层覆盖或恢复继承", showInstructions: false, initialValue: scope.override[field] === undefined ? "inherit" : String(scope.override[field]), options: [
    { value: "inherit", label: "恢复继承上级" },
    ...(scope.writable ? field === "operation_updates" ? [{ value: "full", label: "完整详情" }, { value: "detailed", label: "日常明细" }, { value: "compact", label: "单行摘要" }, { value: "failures", label: "仅失败或拒绝" }, { value: "hidden", label: "隐藏" }] : field === "completion" ? [{ value: "off", label: "关闭成功通知" }, { value: "brief", label: "精简" }, { value: "detailed", label: "详细" }] : field === "presentation_detail" ? [{ value: "basic", label: "基础" }, { value: "detailed", label: "详细" }, { value: "full", label: "完整" }] : [{ value: "true", label: "开启" }, { value: "false", label: "关闭" }] : []),
    { value: "back", label: "返回上一级" },
  ] });
  if (prompts.isCancel(value) || value === "back") return { action: "back" };
  if (field === "streaming" && !["true", "false", "inherit"].includes(value)) throw new Error("未知流式显示选项");
  if (field === "commentary" && !["true", "false", "inherit"].includes(value)) throw new Error("未知过程说明选项");
  if (field === "routine_notifications" && !["true", "false", "inherit"].includes(value)) throw new Error("未知常规通知选项");
  const edit = { kind: "display.scope", value: value === "inherit" ? { selector: scope.selector, field, action: "inherit" } : { selector: scope.selector, field, action: "set", value: field === "operation_updates" || field === "completion" || field === "presentation_detail" ? value : value === "true" } };
  const preview = updateGatewaySetting(edit, { environment, expectedRevision: settings.revision, writeConfig: () => undefined, skipBackup: true });
  output.write(`预览目标：${label(scope)}\n${displayScopeSummary(preview.value)}\n保存前创建私有配置备份；新增覆盖要求新版 Gateway。保存后按提示激活，已有 pending 仍可能投递；重启恢复不保证原有详细或紧凑版式。回退前按旧版能力显式清除新增 overrides、全局及覆盖 completion/subagents/streaming/commentary/routine_notifications/presentation_detail，并将全局及覆盖 detailed/failures 改为旧版支持值；核对后续修改，勿直接恢复备份覆盖配置。\n`);
  const fieldName = { operation_updates: "操作详情", subagents: "子代理显示", streaming: "流式显示", commentary: "过程说明", routine_notifications: "常规通知", plan_updates: "计划更新", reasoning: "思考状态", completion: "完成通知", presentation_detail: "消息详情" }[field];
  const confirmed = await prompts.confirm({ message: `确认修改 ${label(scope)} 的${fieldName}？`, initialValue: false });
  if (prompts.isCancel(confirmed) || !confirmed) return { action: "back" };
  const result = updateGatewaySetting(edit, { environment, expectedRevision: settings.revision, writeConfig });
  let current;
  try { current = loadGatewaySettings(environment); } catch {
    output.write(`保存操作已返回，但配置读回未确认，请重新读取配置，勿重复保存：${result.configPath}\n`);
    return { ...result, consistency: "unknown" };
  }
  const saved = current.display.scopes.find(entry => entry.id === scope.id);
  const expected = value === "inherit" ? undefined : field === "operation_updates" || field === "completion" || field === "presentation_detail" ? value : value === "true";
  if (saved?.override[field] !== expected) {
    output.write(`保存后当前值与预览不同，请重新读取并核对，勿重复保存：${result.configPath}\n`);
    return { ...result, consistency: "unknown" };
  }
  output.write(`${result.activation === "none" ? "设置未变化" : "范围显示已保存并读回确认"}：${result.configPath}\n${result.backupPath ? `私有备份：${result.backupPath}\n` : ""}`);
  writeGatewayConfigActivationNotice(output, environment, result.activationResult);
  return { ...result, consistency: "confirmed" };
}

function displayScopeSummary(scope) {
  const values = { full: "完整", compact: "紧凑", failures: "仅失败或拒绝", hidden: "隐藏", true: "开启", false: "关闭", off: "关闭成功通知", brief: "精简", detailed: "详细", basic: "基础" };
  const sources = { global: "全局", surface: "渠道", account: "账号", "chat-kind": "聊天类型", chat: "指定聊天" };
  return [`显示预设：${presetLabels[scope.preset] ?? "自定义"}（根据有效字段识别，不保存预设标签）。`, "按已保存配置计算，非当前运行状态；保存后按提示激活。", ...[
    ["operation_updates", "operationUpdates", "操作详情"], ["plan_updates", "planUpdatesEnabled", "计划更新"], ["reasoning", "reasoningEnabled", "思考状态"], ["completion", "completion", "完成通知"],
    ["subagents", "subagentsEnabled", "子代理显示"],
    ["streaming", "streamingEnabled", "流式显示"],
    ["commentary", "commentaryEnabled", "过程说明"],
    ["routine_notifications", "routineNotificationsEnabled", "常规通知"],
    ["presentation_detail", "presentationDetail", "消息详情"],
  ].filter(([field]) => scope.supportedFields.includes(field)).map(([field, effective, label]) => `${label}：本层${scope.override[field] === undefined ? scope.selector === null ? "使用缺省" : "继承上级" : values[String(scope.override[field])]}；有效${values[String(scope.effective[effective])]}；来源${sources[scope.sources[effective]]}`)].join("\n");
}

const presetLabels = { concise: "静默", standard: "紧凑", detailed: "详细", full: "完整", custom: "自定义" };

async function runDisplayPresetSettings({ environment, output, prompts, writeConfig, settings = loadGatewaySettings(environment), scope }) {
  const target = scope ? [scope.selector.surface, scope.selector.account_id, scope.selector.chat_kind, scope.selector.chat_id].filter(Boolean).join(" / ") : "全局";
  const currentState = scope ?? settings.display.globalScope;
  output.write(`当前目标：${target}\n${displayScopeSummary(currentState)}\n预设只一次应用现有显示字段，之后仍按字段继承；不改变日志、调用采集、模型统计分组或 Telegram 消息格式。\n`);
  const preset = await prompts.select({ message: "选择显示预设", showInstructions: false, initialValue: currentState.preset === "custom" ? undefined : currentState.preset,
    options: [...Object.keys(messageDisplayPresets).map(value => ({ value, label: presetLabels[value] })), { value: "back", label: "返回上一级" }],
  });
  if (prompts.isCancel(preset) || preset === "back") return { action: "back" };
  const edit = { kind: "display.preset", value: { preset, ...(scope ? { selector: scope.selector } : {}) } };
  const preview = updateGatewaySetting(edit, { environment, expectedRevision: settings.revision, writeConfig: () => undefined, skipBackup: true });
  output.write(`预览目标：${target}\n${displayScopeSummary(preview.value)}\n${preview.activation === "none" ? "配置未变化，不写入或创建备份。" : "一次保存本层全部支持字段，保存前创建私有配置备份。"}保存后按提示激活；已有 pending 仍可能投递，重启恢复不保证原有详细或紧凑版式。回退前按旧版能力显式清除新增 overrides、全局及覆盖 completion/subagents/streaming/commentary/routine_notifications/presentation_detail，并将全局及覆盖 detailed/failures 改为旧版支持值；核对后续修改，勿直接恢复备份覆盖配置。\n`);
  const confirmed = await prompts.confirm({ message: `确认向 ${target} 应用${presetLabels[preset]}显示预设及以上全部字段？`, initialValue: false });
  if (prompts.isCancel(confirmed) || !confirmed) return { action: "back" };
  const result = updateGatewaySetting(edit, { environment, expectedRevision: settings.revision, writeConfig });
  let saved;
  try {
    const current = loadGatewaySettings(environment);
    saved = scope ? current.display.scopes.find(entry => entry.id === scope.id) : current.display.globalScope;
  } catch { /* Keep a completed write when readback is unavailable. */ }
  if (JSON.stringify(saved) !== JSON.stringify(preview.value)) {
    output.write(`保存操作已返回，但配置读回未确认，请重新读取并核对，勿重复保存：${result.configPath}\n`);
    return { ...result, consistency: "unknown" };
  }
  output.write(`${result.activation === "none" ? "设置未变化" : "显示预设已保存并读回确认"}：${target}；${result.configPath}\n${displayScopeSummary(saved)}\n${result.backupPath ? `私有备份：${result.backupPath}\n` : ""}`);
  writeGatewayConfigActivationNotice(output, environment, result.activationResult);
  return { ...result, consistency: "confirmed" };
}

async function runPresentationDetailSettings({ environment, output, prompts, writeConfig }) {
  const settings = loadGatewaySettings(environment);
  const labels = { basic: "基础", detailed: "详细", full: "完整" };
  output.write(`消息详情：本层${settings.display.presentationDetailOverride === null ? "缺省" : labels[settings.display.presentationDetailOverride]}；有效${labels[settings.display.presentationDetail]}；来源全局。\n基础使用紧凑的上线、完成、子代理和自动审批通过摘要；详细保留会话摘要与本轮关键统计；完整展开环境、本轮统计分项及审批详情，过滤重复过程通知；不改变日志等级、调用采集、任务、审批或完成通知开关。\n`);
  const value = await prompts.select({ message: "选择全局消息详情", showInstructions: false, initialValue: settings.display.presentationDetailOverride ?? "inherit", options: [
    { value: "inherit", label: "恢复缺省（基础，不保存覆盖）" }, ...Object.entries(labels).map(([value, label]) => ({ value, label })), { value: "back", label: "返回上一级" },
  ] });
  if (prompts.isCancel(value) || value === "back") return { action: "back" };
  const edit = { kind: "display.presentation-detail", value: value === "inherit" ? { action: "inherit" } : { action: "set", value } };
  const preview = updateGatewaySetting(edit, { environment, expectedRevision: settings.revision, writeConfig: () => undefined, skipBackup: true });
  output.write(`预览：全局消息详情${labels[preview.value.presentationDetail]}；${value === "inherit" ? "删除覆盖字段" : "保存显式覆盖"}。保存前创建私有备份，保存后按提示激活。回退到旧版前显式清除全局及覆盖 presentation_detail，核对后续修改，勿直接覆盖配置。\n`);
  const confirmed = await prompts.confirm({ message: "确认修改全局消息详情？", initialValue: false });
  if (prompts.isCancel(confirmed) || !confirmed) return { action: "back" };
  const result = updateGatewaySetting(edit, { environment, expectedRevision: settings.revision, writeConfig });
  let current;
  try { current = loadGatewaySettings(environment); } catch { /* Preserve saved state when readback is unavailable. */ }
  if (!current || current.display.presentationDetailOverride !== preview.value.presentationDetailOverride) {
    output.write(`保存操作已返回，但配置读回未确认，请重新读取配置，勿重复保存：${result.configPath}\n`);
    return { ...result, consistency: "unknown" };
  }
  output.write(`${result.activation === "none" ? "设置未变化" : "消息详情已保存并读回确认"}：${result.configPath}\n${result.backupPath ? `私有备份：${result.backupPath}\n` : ""}`);
  writeGatewayConfigActivationNotice(output, environment, result.activationResult);
  return { ...result, consistency: "confirmed" };
}

async function runCompletionSettings({ environment, output, prompts, writeConfig }) {
  const settings = loadGatewaySettings(environment);
  const labels = { off: "关闭成功通知", brief: "精简", detailed: "详细" };
  output.write(`完成通知：本层${settings.display.completionOverride === null ? "缺省" : labels[settings.display.completionOverride]}；有效${labels[settings.display.completion]}；来源全局。\n关闭仅隐藏新的成功且没有错误、没有缺少最终回答的完成通知；失败、停止、缺少最终回答和已有 pending 保留。精简不代表正文已送达。\n`);
  const value = await prompts.select({ message: "选择全局完成通知", showInstructions: false, initialValue: settings.display.completionOverride ?? "inherit", options: [
    { value: "inherit", label: "恢复缺省（详细，不保存覆盖）" }, ...Object.entries(labels).map(([value, label]) => ({ value, label })), { value: "back", label: "返回上一级" },
  ] });
  if (prompts.isCancel(value) || value === "back") return { action: "back" };
  const edit = { kind: "display.completion", value: value === "inherit" ? { action: "inherit" } : { action: "set", value } };
  const preview = updateGatewaySetting(edit, { environment, expectedRevision: settings.revision, writeConfig: () => undefined, skipBackup: true });
  output.write(`预览：全局完成通知${labels[preview.value.completion]}；${value === "inherit" ? "删除覆盖字段" : "保存显式覆盖"}。保存前创建私有备份，保存后按提示重启 Gateway；已有 pending 仍可能投递。回退前核对后续修改，勿直接覆盖配置。\n`);
  const confirmed = await prompts.confirm({ message: "确认修改全局完成通知？", initialValue: false });
  if (prompts.isCancel(confirmed) || !confirmed) return { action: "back" };
  const result = updateGatewaySetting(edit, { environment, expectedRevision: settings.revision, writeConfig });
  let current;
  try { current = loadGatewaySettings(environment); } catch { /* Saved state is retained; report readback uncertainty. */ }
  if (!current || current.display.completionOverride !== preview.value.completionOverride) {
    output.write(`保存操作已返回，但配置读回未确认，请重新读取配置，勿重复保存：${result.configPath}\n`);
    return { ...result, consistency: "unknown" };
  }
  output.write(`${result.activation === "none" ? "设置未变化" : "完成通知已保存并读回确认"}：${result.configPath}\n${result.backupPath ? `私有备份：${result.backupPath}\n` : ""}`);
  writeGatewayConfigActivationNotice(output, environment, result.activationResult);
  return { ...result, consistency: "confirmed" };
}

async function runRoutineNotificationsSettings({ environment, output, prompts, writeConfig }) {
  const settings = loadGatewaySettings(environment);
  const label = value => value ? "开启" : "关闭";
  output.write(`常规通知：本层${settings.display.routineNotificationsOverride === null ? "缺省" : label(settings.display.routineNotificationsOverride)}；有效${label(settings.display.routineNotificationsEnabled)}；来源全局。\n四渠道按五层范围继承；关闭常规启动、成功配置提示、空闲释放、成功或运行中的压缩、成功 Hook、自动审批通过、MCP starting/ready、线程名称与可用状态、连接恢复通知。失败、拒绝、停止、重试、账号与额度、OAuth、需用户操作、正文、附件、审批和命令回执保留。启动摘要含结构化鉴权或健康异常时仍显示；持久 Workspace 新增回执和已有 pending 按原义务保留。\n`);
  const value = await prompts.select({ message: "选择全局常规通知", showInstructions: false, initialValue: settings.display.routineNotificationsOverride === null ? "inherit" : String(settings.display.routineNotificationsOverride), options: [
    { value: "inherit", label: "恢复缺省（开启，不保存覆盖）" }, { value: "true", label: "开启" }, { value: "false", label: "关闭" }, { value: "back", label: "返回上一级" },
  ] });
  if (prompts.isCancel(value) || value === "back") return { action: "back" };
  if (!["true", "false", "inherit"].includes(value)) throw new Error("未知常规通知选项");
  const edit = { kind: "display.routine-notifications", value: value === "inherit" ? { action: "inherit" } : { action: "set", value: value === "true" } };
  const preview = updateGatewaySetting(edit, { environment, expectedRevision: settings.revision, writeConfig: () => undefined, skipBackup: true });
  output.write(`预览：全局常规通知${label(preview.value.routineNotificationsEnabled)}；${value === "inherit" ? "删除覆盖字段" : "保存显式覆盖"}。保存前创建私有备份，保存后按提示激活；此字段要求新版 Gateway。回退前显式清除全局及覆盖 routine_notifications，核对后续修改，勿直接覆盖配置。\n`);
  const confirmed = await prompts.confirm({ message: "确认修改全局常规通知？", initialValue: false });
  if (prompts.isCancel(confirmed) || !confirmed) return { action: "back" };
  const result = updateGatewaySetting(edit, { environment, expectedRevision: settings.revision, writeConfig });
  let current;
  try { current = loadGatewaySettings(environment); } catch { /* Preserve saved state when readback is unavailable. */ }
  if (!current || current.display.routineNotificationsOverride !== preview.value.routineNotificationsOverride) {
    output.write(`保存操作已返回，但配置读回未确认，请重新读取配置，勿重复保存：${result.configPath}\n`);
    return { ...result, consistency: "unknown" };
  }
  output.write(`${result.activation === "none" ? "设置未变化" : "常规通知已保存并读回确认"}：${result.configPath}\n${result.backupPath ? `私有备份：${result.backupPath}\n` : ""}`);
  writeGatewayConfigActivationNotice(output, environment, result.activationResult);
  return { ...result, consistency: "confirmed" };
}

async function runCommentarySettings({ environment, output, prompts, writeConfig }) {
  const settings = loadGatewaySettings(environment);
  const label = value => value ? "开启" : "关闭";
  output.write(`过程说明：本层${settings.display.commentaryOverride === null ? "缺省" : label(settings.display.commentaryOverride)}；有效${label(settings.display.commentaryEnabled)}；来源全局。\n只控制 Telegram、飞书与 QQ（含已支持群）的 commentary 过程说明，不是思考状态或原始推理。关闭时未知阶段增量暂不预览，明确为最终回答或完整消息后再展示；未知阶段完整正文、附件、审批、失败、任务和模型保留。已准入正文流与已有 pending 按原义务收尾。微信本来不显示 commentary，不支持此覆盖。\n`);
  const value = await prompts.select({ message: "选择全局过程说明", showInstructions: false, initialValue: settings.display.commentaryOverride === null ? "inherit" : String(settings.display.commentaryOverride), options: [
    { value: "inherit", label: "恢复缺省（开启，不保存覆盖）" }, { value: "true", label: "开启" }, { value: "false", label: "关闭" }, { value: "back", label: "返回上一级" },
  ] });
  if (prompts.isCancel(value) || value === "back") return { action: "back" };
  if (!["true", "false", "inherit"].includes(value)) throw new Error("未知过程说明选项");
  const edit = { kind: "display.commentary", value: value === "inherit" ? { action: "inherit" } : { action: "set", value: value === "true" } };
  const preview = updateGatewaySetting(edit, { environment, expectedRevision: settings.revision, writeConfig: () => undefined, skipBackup: true });
  output.write(`预览：全局过程说明${label(preview.value.commentaryEnabled)}；${value === "inherit" ? "删除覆盖字段" : "保存显式覆盖"}。保存前创建私有备份，保存后按提示激活；此字段要求新版 Gateway。回退前显式清除全局及覆盖 commentary，核对后续修改，勿直接覆盖配置。\n`);
  const confirmed = await prompts.confirm({ message: "确认修改全局过程说明？", initialValue: false });
  if (prompts.isCancel(confirmed) || !confirmed) return { action: "back" };
  const result = updateGatewaySetting(edit, { environment, expectedRevision: settings.revision, writeConfig });
  let current;
  try { current = loadGatewaySettings(environment); } catch { /* Preserve saved state when readback is unavailable. */ }
  if (!current || current.display.commentaryOverride !== preview.value.commentaryOverride) {
    output.write(`保存操作已返回，但配置读回未确认，请重新读取配置，勿重复保存：${result.configPath}\n`);
    return { ...result, consistency: "unknown" };
  }
  output.write(`${result.activation === "none" ? "设置未变化" : "过程说明已保存并读回确认"}：${result.configPath}\n${result.backupPath ? `私有备份：${result.backupPath}\n` : ""}`);
  writeGatewayConfigActivationNotice(output, environment, result.activationResult);
  return { ...result, consistency: "confirmed" };
}

async function runStreamingSettings({ environment, output, prompts, writeConfig }) {
  const settings = loadGatewaySettings(environment);
  const label = value => value ? "开启" : "关闭";
  output.write(`流式显示：本层${settings.display.streamingOverride === null ? "缺省" : label(settings.display.streamingOverride)}；有效${label(settings.display.streamingEnabled)}；来源全局。\n仅控制 Telegram、飞书与 QQ 单聊的正文增量预览；不改变上游模型流式、思考状态、完整正文、附件、授权及原窗口和交付义务。微信与 QQ 群不支持流式显示。\n`);
  const value = await prompts.select({ message: "选择全局流式显示", showInstructions: false, initialValue: settings.display.streamingOverride === null ? "inherit" : String(settings.display.streamingOverride), options: [
    { value: "inherit", label: "恢复缺省（开启，不保存覆盖）" }, { value: "true", label: "开启" }, { value: "false", label: "关闭" }, { value: "back", label: "返回上一级" },
  ] });
  if (prompts.isCancel(value) || value === "back") return { action: "back" };
  if (!["true", "false", "inherit"].includes(value)) throw new Error("未知流式显示选项");
  const edit = { kind: "display.streaming", value: value === "inherit" ? { action: "inherit" } : { action: "set", value: value === "true" } };
  const preview = updateGatewaySetting(edit, { environment, expectedRevision: settings.revision, writeConfig: () => undefined, skipBackup: true });
  output.write(`预览：全局流式显示${label(preview.value.streamingEnabled)}；${value === "inherit" ? "删除覆盖字段" : "保存显式覆盖"}。保存前创建私有备份，保存后按提示激活；此字段要求新版 Gateway。回退前显式清除全局及覆盖 streaming，核对后续修改，勿直接覆盖配置。\n`);
  const confirmed = await prompts.confirm({ message: "确认修改全局流式显示？", initialValue: false });
  if (prompts.isCancel(confirmed) || !confirmed) return { action: "back" };
  const result = updateGatewaySetting(edit, { environment, expectedRevision: settings.revision, writeConfig });
  let current;
  try { current = loadGatewaySettings(environment); } catch { /* Preserve saved state when readback is unavailable. */ }
  if (!current || current.display.streamingOverride !== preview.value.streamingOverride) {
    output.write(`保存操作已返回，但配置读回未确认，请重新读取配置，勿重复保存：${result.configPath}\n`);
    return { ...result, consistency: "unknown" };
  }
  output.write(`${result.activation === "none" ? "设置未变化" : "流式显示已保存并读回确认"}：${result.configPath}\n${result.backupPath ? `私有备份：${result.backupPath}\n` : ""}`);
  writeGatewayConfigActivationNotice(output, environment, result.activationResult);
  return { ...result, consistency: "confirmed" };
}

async function runSubagentsSettings({ environment, output, prompts, writeConfig }) {
  const settings = loadGatewaySettings(environment);
  const label = value => value ? "开启" : "关闭";
  output.write(`子代理显示：本层${settings.display.subagentsOverride === null ? "缺省" : label(settings.display.subagentsOverride)}；有效${label(settings.display.subagentsEnabled)}；来源全局。\n关闭隐藏子代理生命周期与子代理工具操作，其他工具仍按操作详情档位；正文、图片、审批与父轮完成或失败保留。已有待投递子代理结果仍可能发送。\n`);
  const value = await prompts.select({ message: "选择全局子代理显示", showInstructions: false, initialValue: settings.display.subagentsOverride === null ? "inherit" : String(settings.display.subagentsOverride), options: [
    { value: "inherit", label: "恢复缺省（开启，不保存覆盖）" }, { value: "true", label: "开启" }, { value: "false", label: "关闭" }, { value: "back", label: "返回上一级" },
  ] });
  if (prompts.isCancel(value) || value === "back") return { action: "back" };
  const edit = { kind: "display.subagents", value: value === "inherit" ? { action: "inherit" } : { action: "set", value: value === "true" } };
  const preview = updateGatewaySetting(edit, { environment, expectedRevision: settings.revision, writeConfig: () => undefined, skipBackup: true });
  output.write(`预览：全局子代理显示${label(preview.value.subagentsEnabled)}；${value === "inherit" ? "删除覆盖字段" : "保存显式覆盖"}。保存前创建私有备份；保存后按提示激活。回退前按旧版能力显式清除新增 overrides、全局及覆盖 completion/subagents/streaming/presentation_detail，并将全局及覆盖 detailed/failures 改为旧版支持值；核对后续修改，勿直接覆盖配置。\n`);
  const confirmed = await prompts.confirm({ message: "确认修改全局子代理显示？", initialValue: false });
  if (prompts.isCancel(confirmed) || !confirmed) return { action: "back" };
  const result = updateGatewaySetting(edit, { environment, expectedRevision: settings.revision, writeConfig });
  let current;
  try { current = loadGatewaySettings(environment); } catch { /* Preserve saved state when readback is unavailable. */ }
  if (!current || current.display.subagentsOverride !== preview.value.subagentsOverride) {
    output.write(`保存操作已返回，但配置读回未确认，请重新读取配置，勿重复保存：${result.configPath}\n`);
    return { ...result, consistency: "unknown" };
  }
  output.write(`${result.activation === "none" ? "设置未变化" : "子代理显示已保存并读回确认"}：${result.configPath}\n${result.backupPath ? `私有备份：${result.backupPath}\n` : ""}`);
  writeGatewayConfigActivationNotice(output, environment, result.activationResult);
  return { ...result, consistency: "confirmed" };
}

async function runModelDisplayGroups({ environment, output, prompts, writeConfig }) {
  while (true) {
    const settings = loadGatewaySettings(environment);
    const aliases = settings.display.modelAliases;
    const groups = [...new Set(Object.values(aliases))];
    writeModelDisplayGroups(output, aliases);
    const selected = await prompts.select({
      message: "模型统计分组",
      showInstructions: false,
      options: [
        ...groups.map((group, index) => ({ value: `group:${index}`, label: group,
          hint: Object.keys(aliases).filter((model) => aliases[model] === group).join("、") })),
        { value: "add", label: "新增统计组", hint: "设置组名并逐个添加原始模型 ID" },
        { value: "back", label: "返回上一级" },
      ],
    });
    if (prompts.isCancel(selected) || selected === "back") return { action: "back" };
    const group = selected === "add" ? null : groups[Number(String(selected).slice(6))];
    if (group === undefined) throw new Error("未知模型统计组");
    const action = group === null ? "edit" : await prompts.select({
      message: `统计组：${group}`,
      showInstructions: false,
      options: [
        { value: "edit", label: "编辑组名与成员" },
        { value: "delete", label: "删除统计组", hint: "该组模型恢复按原始模型 ID 分别统计" },
        { value: "back", label: "返回上一级" },
      ],
    });
    if (prompts.isCancel(action) || action === "back") continue;
    const next = { ...aliases };
    if (group !== null) {
      for (const model of Object.keys(next)) if (next[model] === group) delete next[model];
    }
    if (action === "delete") {
      const confirmed = await prompts.confirm({
        message: `删除统计组“${group}”及其全部成员映射？保留原始记录与模型明细。`,
        initialValue: false,
      });
      if (prompts.isCancel(confirmed) || !confirmed) continue;
    } else if (action === "edit") {
      let providers = [];
      try {
        providers = loadManagedModelProviderSettings(environment);
      } catch {
        output.write("已配置模型目录暂不可读取，仍可手填组名与原始模型 ID。\n");
      }
      const edited = await editModelDisplayGroup({ aliases, group, providers, output, prompts });
      if (edited === null) continue;
      for (const model of edited.models) next[model] = edited.name;
    } else {
      throw new Error(`未知模型统计组操作：${String(action)}`);
    }
    validateModelDisplayAliases(next);
    writeModelDisplayGroups(output, next);
    const save = await prompts.confirm({
      message: "保存以上统计组？仅合并控制台按模型统计，模型选择与各项明细保留原模型。",
      initialValue: false,
    });
    if (prompts.isCancel(save) || !save) continue;
    const result = updateGatewaySetting({ kind: "display.model-aliases", value: next }, {
      environment, expectedRevision: settings.revision, writeConfig,
    });
    if (result.activation !== "none") {
      output.write(`模型统计分组已保存：${result.configPath}；控制台重新读取后生效，模型选择与明细保留原模型。\n`);
    }
    if (result.backupPath) output.write(`原配置备份：${result.backupPath}\n`);
    writeGatewayConfigActivationNotice(output, environment, result.activationResult);
    return { modelAliases: next, configPath: result.configPath,
      activation: result.activation, activationResult: result.activationResult };
  }
}

async function editModelDisplayGroup({ aliases, group, providers, output, prompts }) {
  const deepseekModels = [...new Set(providers.filter((provider) =>
    provider.provider === "deepseek" || provider.provider.startsWith("ds-"))
    .flatMap((provider) => provider.models.map((model) => model.model)))];
  let suggestedName = group;
  let targetModel;
  if (deepseekModels.length) {
    const selected = await prompts.select({
      message: "选择 DeepSeek 模型名作为统计组名，或手填组名",
      showInstructions: false,
      options: [...deepseekModels.map((model, index) => ({ value: `name:${index}`, label: model })),
        { value: "custom", label: "手填组名", hint: group ?? "自定义统计组" }],
    });
    if (prompts.isCancel(selected)) return null;
    if (selected !== "custom") {
      suggestedName = deepseekModels[Number(String(selected).slice(5))];
      if (suggestedName === undefined) throw new Error("未知 DeepSeek 模型名");
      targetModel = suggestedName;
    }
  }
  const name = await prompts.text({
    message: "统计组名（1–120 字符）",
    ...(suggestedName === null ? {} : { initialValue: suggestedName }),
    validate: (value) => {
      const error = modelDisplayAliasesError({ "display-name-validation": value });
      if (error) return error;
      return value !== group && Object.values(aliases).includes(value)
        ? "此统计组已存在，请返回并编辑该组" : undefined;
    },
  });
  if (prompts.isCancel(name)) return null;
  validateModelDisplayAliases({ "display-name-validation": name });
  if (name !== group && Object.values(aliases).includes(name)) throw new Error("统计组名已存在");
  const models = Object.keys(aliases).filter((model) => aliases[model] === group);
  if (targetModel !== undefined && !models.includes(targetModel)) {
    if (Object.hasOwn(aliases, targetModel) && aliases[targetModel] !== group) {
      output.write("所选 DS 模型已属于其他统计组，请先编辑原组。\n");
      return null;
    }
    models.push(targetModel);
  }
  while (true) {
    output.write(`统计组“${name}”成员：${models.length ? models.join("、") : "暂无"}\n`);
    const action = await prompts.select({
      message: "编辑原始模型 ID 成员",
      showInstructions: false,
      options: [
        { value: "add", label: "添加成员", hint: "每次输入一个精确原始模型 ID，支持 /" },
        ...(models.length ? [{ value: "remove", label: "移除成员" }, { value: "done", label: "完成编辑" }] : []),
        { value: "cancel", label: "取消编辑" },
      ],
    });
    if (prompts.isCancel(action) || action === "cancel") return null;
    if (action === "done" && models.length) {
      const next = { ...aliases };
      for (const member of Object.keys(next)) if (next[member] === group) delete next[member];
      for (const member of models) next[member] = name;
      const error = modelDisplayAliasesError(next);
      if (error) {
        output.write(`${error}，请调整成员后重试。\n`);
        continue;
      }
      return { name, models };
    }
    if (action === "remove" && models.length) {
      const selected = await prompts.select({
        message: "选择要移除的原始模型 ID",
        showInstructions: false,
        options: [...models.map((model, index) => ({ value: `model:${index}`, label: model })),
          { value: "back", label: "返回上一级" }],
      });
      if (prompts.isCancel(selected) || selected === "back") continue;
      const index = Number(String(selected).slice(6));
      if (!Number.isInteger(index) || index < 0 || index >= models.length) throw new Error("未知模型成员");
      models.splice(index, 1);
    } else if (action === "add") {
      const validate = (model) => {
        const error = modelDisplayAliasesError({ [model]: name });
        if (error) return error;
        if (models.includes(model)) return "该模型已在此统计组中";
        if (Object.hasOwn(aliases, model) && aliases[model] !== group) return "该模型已在其他统计组中，请先从原组移除";
        const next = { ...aliases };
        for (const member of Object.keys(next)) if (next[member] === group) delete next[member];
        for (const member of models) next[member] = name;
        next[model] = name;
        return modelDisplayAliasesError(next);
      };
      const candidates = providers.flatMap((provider) => provider.models
        .filter((candidate) => validate(candidate.model) === undefined)
        .map((candidate) => ({ model: candidate.model, label: `${provider.displayName} · ${candidate.model}` })));
      let model;
      if (candidates.length) {
        const selected = await prompts.select({
          message: "选择原始模型 ID，或手填尚未采集的模型",
          showInstructions: false,
          options: [...candidates.map((candidate, index) => ({ value: `candidate:${index}`, label: candidate.label })),
            { value: "custom", label: "手填原始模型 ID" }, { value: "back", label: "返回上一级" }],
        });
        if (prompts.isCancel(selected) || selected === "back") continue;
        if (selected !== "custom") {
          model = candidates[Number(String(selected).slice(10))]?.model;
          if (model === undefined) throw new Error("未知模型候选");
        }
      }
      if (model === undefined) model = await prompts.text({ message: "原始模型 ID（精确匹配，不改写 ID）", validate });
      if (prompts.isCancel(model)) continue;
      const error = validate(model);
      if (error) throw new Error(error);
      models.push(model);
    } else {
      throw new Error(`未知模型成员操作：${String(action)}`);
    }
  }
}

function modelDisplayAliasesError(value) {
  try {
    validateModelDisplayAliases(value);
    return undefined;
  } catch (error) {
    return error.message;
  }
}

function writeModelDisplayGroups(output, aliases) {
  const groups = [...new Set(Object.values(aliases))];
  output.write("模型统计分组（原始模型 ID → 统计组名；仅合并控制台按模型统计，保留明细）：\n");
  if (!groups.length) output.write("  暂无映射，默认按原始模型 ID 分别统计。\n");
  for (const group of groups) {
    for (const model of Object.keys(aliases)) if (aliases[model] === group) output.write(`  ${model} → ${group}\n`);
  }
}

async function runTelegramMessageFormat({
  environment,
  output,
  prompts,
  writeConfig = writeGatewayConfig,
}) {
  const settings = loadGatewaySettings(environment);
  const selected = await prompts.select({
    message: "Telegram 消息格式",
    showInstructions: false,
    initialValue: settings.telegram.messageFormat,
    options: [
      { value: "html", label: "HTML", hint: "使用 HTML 格式" },
      { value: "rich", label: "富文本", hint: "使用富文本消息" },
      { value: "back", label: "返回上一级" },
    ],
  });
  if (prompts.isCancel(selected) || selected === "back") return { action: "back" };
  if (selected !== "html" && selected !== "rich") {
    throw new Error(`未知 Telegram 消息格式：${String(selected)}`);
  }
  const result = updateGatewaySetting({
    kind: "telegram.message-format",
    value: selected,
  }, { environment, expectedRevision: settings.revision, writeConfig });
  output.write(`Telegram 消息格式已设为 ${selected}：${result.configPath}\n`);
  writeGatewayConfigActivationNotice(output, environment, result.activationResult);
  return { messageFormat: selected, configPath: result.configPath, activation: result.activation, activationResult: result.activationResult };
}

async function runOperationUpdatesToggle({ environment, output, prompts, writeConfig }) {
  const settings = loadGatewaySettings(environment);
  const selected = await prompts.select({
    message: "操作详情显示",
    showInstructions: false,
    initialValue: settings.display.operationUpdates,
    options: [
      { value: "full", label: "完整详情", hint: "显示完整操作过程" },
      { value: "detailed", label: "日常明细", hint: "正常详情最多 600 字符，失败或拒绝保留完整脱敏原因" },
      { value: "compact", label: "单行摘要", hint: "压缩为摘要行" },
      { value: "failures", label: "仅失败或拒绝", hint: "仅显示 failed / declined 操作" },
      { value: "hidden", label: "隐藏", hint: "不显示操作过程" },
      { value: "back", label: "返回上一级" },
    ],
  });
  if (prompts.isCancel(selected) || selected === "back") return { action: "back" };
  if (selected !== "full" && selected !== "detailed" && selected !== "compact" && selected !== "failures" && selected !== "hidden") {
    throw new Error(`未知操作详情显示设置：${String(selected)}`);
  }
  const edit = {
    kind: "display.operation-updates",
    value: selected,
  };
  if (selected === "failures" || selected === "detailed") {
    const preview = updateGatewaySetting(edit, { environment, expectedRevision: settings.revision, writeConfig: () => undefined, skipBackup: true });
    output.write(`预览：操作详情从 ${settings.display.operationUpdates} 改为 ${preview.value}。${selected === "failures" ? "仅展示 failed/declined。" : "显示完整过程，正常详情最多 600 字符；失败或拒绝保留完整脱敏详情。"}该档位要求新版 Gateway；保存前创建私有备份，保存后按提示激活。回退前按旧版能力显式清除新增 overrides、全局及覆盖 completion/subagents/streaming/presentation_detail，并将全局及覆盖 detailed/failures 改为旧版支持值；核对后续修改，勿直接覆盖配置。\n`);
    const confirmed = await prompts.confirm({ message: `确认修改全局操作详情为${selected === "failures" ? "仅失败或拒绝" : "日常明细"}？`, initialValue: false });
    if (prompts.isCancel(confirmed) || !confirmed) return { action: "back" };
  }
  const result = updateGatewaySetting(edit, { environment, expectedRevision: settings.revision, writeConfig });
  output.write(`操作详情显示已设为${selected}：${result.configPath}\n`);
  if (result.backupPath) output.write(`私有备份：${result.backupPath}\n`);
  writeGatewayConfigActivationNotice(output, environment, result.activationResult);
  return { operationUpdates: selected, configPath: result.configPath, activation: result.activation, activationResult: result.activationResult };
}

async function runPlanUpdatesToggle({ environment, output, prompts, writeConfig }) {
  const settings = loadGatewaySettings(environment);
  const selected = await prompts.select({
    message: "计划更新显示",
    showInstructions: false,
    initialValue: settings.display.planUpdatesEnabled ? "enabled" : "disabled",
    options: [
      { value: "enabled", label: "开启", hint: "显示 Codex 计划" },
      { value: "disabled", label: "关闭", hint: "隐藏 Codex 计划" },
      { value: "back", label: "返回上一级" },
    ],
  });
  if (prompts.isCancel(selected) || selected === "back") return { action: "back" };
  if (selected !== "enabled" && selected !== "disabled") {
    throw new Error(`未知计划更新显示设置：${String(selected)}`);
  }
  const enabled = selected === "enabled";
  const result = updateGatewaySetting({
    kind: "display.plan-updates",
    value: enabled,
  }, { environment, expectedRevision: settings.revision, writeConfig });
  output.write(`计划更新显示已${enabled ? "开启" : "关闭"}：${result.configPath}\n`);
  writeGatewayConfigActivationNotice(output, environment, result.activationResult);
  return { planUpdatesEnabled: enabled, configPath: result.configPath, activation: result.activation, activationResult: result.activationResult };
}

async function runReasoningToggle({ environment, output, prompts, writeConfig }) {
  const settings = loadGatewaySettings(environment);
  const selected = await prompts.select({
    message: "思考状态显示",
    showInstructions: false,
    initialValue: settings.display.reasoningEnabled ? "enabled" : "disabled",
    options: [
      { value: "enabled", label: "开启", hint: "显示“思考中”状态卡" },
      { value: "disabled", label: "关闭（默认）", hint: "隐藏“思考中”状态卡" },
      { value: "back", label: "返回上一级" },
    ],
  });
  if (prompts.isCancel(selected) || selected === "back") return { action: "back" };
  if (selected !== "enabled" && selected !== "disabled") {
    throw new Error(`未知思考状态显示设置：${String(selected)}`);
  }
  const enabled = selected === "enabled";
  const result = updateGatewaySetting({
    kind: "display.reasoning",
    value: enabled,
  }, { environment, expectedRevision: settings.revision, writeConfig });
  output.write(`思考状态显示已${enabled ? "开启" : "关闭"}：${result.configPath}\n`);
  writeGatewayConfigActivationNotice(output, environment, result.activationResult);
  return { reasoningEnabled: enabled, configPath: result.configPath, activation: result.activation, activationResult: result.activationResult };
}
