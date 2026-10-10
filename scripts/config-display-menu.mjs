import { writeGatewayConfig } from "../runtime/gateway-config.mjs";
import { validateModelDisplayAliases } from "../runtime/model-display-name.mjs";
import { loadManagedModelProviderSettings } from "../runtime/model-provider-runtime.mjs";
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
        { value: "operation_updates", label: "操作详情显示", hint: "full / compact / hidden" },
        { value: "plan_updates", label: "计划更新显示", hint: "是否显示 Codex 计划" },
        { value: "reasoning", label: "思考状态显示", hint: "默认关闭；是否显示“思考中”状态卡" },
        { value: "model_aliases", label: "模型显示组", hint: "WebUI 与频道的组名及原始模型 ID" },
        ...(telegramConfigured ? [{ value: "message_format", label: "Telegram 消息格式", hint: "HTML 或富文本" }] : []),
        { value: "back", label: "返回", hint: "返回配置菜单" },
      ],
    });
    if (prompts.isCancel(section) || section === "back") return { action: "back" };
    let result;
    const options = { environment, output, prompts, writeConfig };
    if (section === "message_format" && telegramConfigured) {
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

async function runModelDisplayGroups({ environment, output, prompts, writeConfig }) {
  while (true) {
    const settings = loadGatewaySettings(environment);
    const aliases = settings.display.modelAliases;
    const groups = [...new Set(Object.values(aliases))];
    writeModelDisplayGroups(output, aliases);
    const selected = await prompts.select({
      message: "模型显示组",
      showInstructions: false,
      options: [
        ...groups.map((group, index) => ({ value: `group:${index}`, label: group,
          hint: Object.keys(aliases).filter((model) => aliases[model] === group).join("、") })),
        { value: "add", label: "新增显示组", hint: "设置组名并逐个添加原始模型 ID" },
        { value: "back", label: "返回上一级" },
      ],
    });
    if (prompts.isCancel(selected) || selected === "back") return { action: "back" };
    const group = selected === "add" ? null : groups[Number(String(selected).slice(6))];
    if (group === undefined) throw new Error("未知模型显示组");
    const action = group === null ? "edit" : await prompts.select({
      message: `显示组：${group}`,
      showInstructions: false,
      options: [
        { value: "edit", label: "编辑组名与成员" },
        { value: "delete", label: "删除显示组", hint: "该组模型恢复原显示名" },
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
        message: `删除显示组“${group}”及其全部成员映射？原始模型 ID 保持不变。`,
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
      throw new Error(`未知模型显示组操作：${String(action)}`);
    }
    validateModelDisplayAliases(next);
    writeModelDisplayGroups(output, next);
    const save = await prompts.confirm({
      message: "保存以上显示组？只改 WebUI 与频道显示及统计分组，保留原始模型 ID。",
      initialValue: false,
    });
    if (prompts.isCancel(save) || !save) continue;
    const result = updateGatewaySetting({ kind: "display.model-aliases", value: next }, {
      environment, expectedRevision: settings.revision, writeConfig,
    });
    output.write(`模型显示组已保存：${result.configPath}；WebUI 刷新页面生效，原始模型 ID 保持不变。\n`);
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
      message: "选择 DeepSeek 模型名作为显示组，或手填组名",
      showInstructions: false,
      options: [...deepseekModels.map((model, index) => ({ value: `name:${index}`, label: model })),
        { value: "custom", label: "手填组名", hint: group ?? "自定义显示组" }],
    });
    if (prompts.isCancel(selected)) return null;
    if (selected !== "custom") {
      suggestedName = deepseekModels[Number(String(selected).slice(5))];
      if (suggestedName === undefined) throw new Error("未知 DeepSeek 模型名");
      targetModel = suggestedName;
    }
  }
  const name = await prompts.text({
    message: "显示组名（1–120 字符）",
    ...(suggestedName === null ? {} : { initialValue: suggestedName }),
    validate: (value) => {
      const error = modelDisplayAliasesError({ "display-name-validation": value });
      if (error) return error;
      return value !== group && Object.values(aliases).includes(value)
        ? "此显示组已存在，请返回并编辑该组" : undefined;
    },
  });
  if (prompts.isCancel(name)) return null;
  validateModelDisplayAliases({ "display-name-validation": name });
  if (name !== group && Object.values(aliases).includes(name)) throw new Error("显示组名已存在");
  const models = Object.keys(aliases).filter((model) => aliases[model] === group);
  if (targetModel !== undefined && !models.includes(targetModel)) {
    if (Object.hasOwn(aliases, targetModel) && aliases[targetModel] !== group) {
      output.write("所选 DS 模型已属于其他显示组，请先编辑原组。\n");
      return null;
    }
    models.push(targetModel);
  }
  while (true) {
    output.write(`显示组“${name}”成员：${models.length ? models.join("、") : "暂无"}\n`);
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
        if (models.includes(model)) return "该模型已在此显示组中";
        if (Object.hasOwn(aliases, model) && aliases[model] !== group) return "该模型已在其他显示组中，请先从原组移除";
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
  output.write("模型显示组（原始模型 ID → 显示组名）：\n");
  if (!groups.length) output.write("  暂无映射，默认使用原显示名。\n");
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
      { value: "compact", label: "单行摘要", hint: "压缩为摘要行" },
      { value: "hidden", label: "隐藏", hint: "不显示操作过程" },
      { value: "back", label: "返回上一级" },
    ],
  });
  if (prompts.isCancel(selected) || selected === "back") return { action: "back" };
  if (selected !== "full" && selected !== "compact" && selected !== "hidden") {
    throw new Error(`未知操作详情显示设置：${String(selected)}`);
  }
  const result = updateGatewaySetting({
    kind: "display.operation-updates",
    value: selected,
  }, { environment, expectedRevision: settings.revision, writeConfig });
  output.write(`操作详情显示已设为${selected}：${result.configPath}\n`);
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
