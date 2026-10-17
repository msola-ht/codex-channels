import { promptResponsesWebSocket } from "./responses-websocket-setup.mjs";
import { promptCustomModelCapabilities } from "./custom-model-capability-setup.mjs";
import { compileResponsesModelCatalog, isCustomCatalogProvider, readResponsesModelCatalog } from "../runtime/model-provider-responses-catalog.mjs";
import { readCustomProviderUpstreamWireApi } from "../runtime/model-provider-upstream-metadata.mjs";
import { loadResponsesModelTemplates, promptResponsesModelImport } from "./responses-model-templates.mjs";
import { promptResponsesModels } from "./responses-model-setup.mjs";
import * as clackPrompts from "@clack/prompts";

import {
  loadConfiguredCustomSwitchingModelProviders,
  customSwitchingProviderProfileName,
  listCustomPrimaryProviderCandidates,
  readPrimaryProviderBackup,
  validateCustomPrimaryModelProviderId,
  readCustomPrimaryProviderApiKey,
} from "../runtime/model-provider-runtime.mjs";
import {
  createCodexUserConfigClient,
} from "./codex-user-config.mjs";
import {
  bundledOfficialModelOptions,
  customPrimaryProviderIdFromBaseUrl,
  customPrimaryProviderUrlsShareOrigin,
  prepareCustomPrimaryProviderSave,
  primaryProviderId,
  validCustomPrimaryProviderBaseUrl,
} from "./custom-primary-provider-management.mjs";
import { writeGatewayConfigActivationNotice } from "./config-activation-notice.mjs";
import { configActivationResult } from "./config-activation-result.mjs";

export { primaryProviderId };

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function optionalString(value) {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function modeOptions() {
  return [
    {
      value: "switching",
      label: "OpenAI + 自定义切换模式",
      hint: "保留官方主实例；独立 App Server，可在渠道 /model 中选择",
    },
    {
      value: "exclusive",
      label: "仅自定义固定模式",
      hint: "自定义 Provider 直接作为主 App Server",
    },
  ];
}

export async function runCustomPrimaryProviderSetup({
  environment = process.env,
  output = process.stdout,
  prompts = clackPrompts,
  allowBack = false,
  createClient = createCodexUserConfigClient,
  providerId: editingProviderId,
  catalogKind = "official",
  loadModelTemplates = source => loadResponsesModelTemplates(source, environment),
  probeWebSocket,
  probeModelCapabilities,
} = {}) {
  const custom = editingProviderId === undefined ? catalogKind === "custom" : isCustomCatalogProvider(editingProviderId);
  const previousCatalog = editingProviderId && custom ? readResponsesModelCatalog(environment, editingProviderId) : undefined;
  const client = await createClient({ environment });
  let snapshot;
  let officialModels;
  try {
    await client.connect();
    [snapshot, officialModels] = await Promise.all([
      client.readUserConfigSnapshot(),
      custom ? [] : client.listModels(),
    ]);
  } finally {
    await client.close().catch(() => undefined);
  }
  const config = record(snapshot.config);
  if (!custom && isCustomCatalogProvider(config.model_provider)) officialModels = bundledOfficialModelOptions(environment);
  const officialModelIds = new Set(
    officialModels.filter((candidate) => candidate.available !== false)
      .map((candidate) => candidate.model),
  );
  if (!custom && officialModelIds.size === 0) {
    throw new Error("Codex App Server 没有返回可用的官方模型");
  }
  const switchingProviders = loadConfiguredCustomSwitchingModelProviders(environment);
  const currentProviders = record(config.model_providers);
  const configuredProviderIds = listCustomPrimaryProviderCandidates(currentProviders, environment);
  const effectiveActiveProviderId = optionalString(config.model_provider);
  const currentMainLabel = effectiveActiveProviderId === undefined
    || effectiveActiveProviderId === "openai"
    ? "OpenAI 官方"
    : effectiveActiveProviderId;
  const hasOfficialMainProvider = effectiveActiveProviderId === undefined
    || effectiveActiveProviderId === "openai";
  const hasCustomFixedMainProvider = effectiveActiveProviderId !== undefined
    && configuredProviderIds.includes(effectiveActiveProviderId);
  const fixedProviderId = optionalString(editingProviderId);
  let fixedProvider;
  let fixedProviderFromConfig = false;
  if (fixedProviderId !== undefined) {
    const validationError = validateCustomPrimaryModelProviderId(fixedProviderId, environment);
    const switchingCandidate = switchingProviders.find(({ id }) => id === fixedProviderId);
    const configured = Object.prototype.hasOwnProperty.call(currentProviders, fixedProviderId);
    fixedProviderFromConfig = switchingCandidate === undefined && configured;
    fixedProvider = record(
      switchingCandidate === undefined
        ? configured
          ? currentProviders[fixedProviderId]
          : readPrimaryProviderBackup(environment)[fixedProviderId]
        : {
            name: switchingCandidate.name,
            base_url: switchingCandidate.baseUrl,
            wire_api: "responses",
            supports_websockets: switchingCandidate.supportsWebsockets,
            experimental_bearer_token: switchingCandidate.apiKey,
          },
    );
    if (
      validationError !== null
      || typeof fixedProvider.base_url !== "string"
      || fixedProvider.wire_api !== "responses"
    ) {
      throw new Error(`未找到可编辑的自定义主 Provider：${fixedProviderId}`);
    }
  }
  const switchingProvider = switchingProviders.find(({ id }) => id === fixedProviderId);
  const currentProvider = fixedProviderId === undefined
    ? {}
    : fixedProvider;
  const currentModel = switchingProvider !== undefined && switchingProvider.id === fixedProviderId
    ? switchingProvider.model
    : effectiveActiveProviderId === fixedProviderId
      ? optionalString(config.model)
      : undefined;
  const currentBaseUrl = optionalString(currentProvider?.base_url) ?? "";
  const currentName = optionalString(currentProvider?.name) ?? "";
  let currentApiKey;
  if (fixedProviderId !== undefined) {
    try { currentApiKey = readCustomPrimaryProviderApiKey(fixedProviderId, currentProvider, environment); }
    catch { output.write("现有凭据无法安全读取，本次编辑必须显式输入新的 API Key。\n"); }
  }
  const hasCurrentBearerToken = currentApiKey !== undefined;
  const hasTopLevelBaseUrl = optionalString(config.openai_base_url) !== undefined;
  const currentWebsockets = currentProvider?.supports_websockets === true ? "yes" : "no";

  output.write(`\nCodex Connect ${custom ? "自定义提供商" : "Codex 兼容 Provider"} Setup\n\n`);
  output.write(`当前主实例：${currentMainLabel}\n`);
  output.write(fixedProviderId === undefined
    ? "当前操作：新增 Provider\n"
    : `当前操作：编辑 ${fixedProviderId}\n`);
  if (fixedProviderId !== undefined) {
    output.write(`当前上游：${currentBaseUrl}\n`);
  }

  const baseUrl = await prompts.text({
    message: "上游 base_url（例如 https://api.example.com/v1）",
    initialValue: currentBaseUrl,
    validate: (value) => {
      const normalized = String(value).trim();
      if (normalized === "") {
        return "base_url 不能为空";
      }
      try {
        validCustomPrimaryProviderBaseUrl(normalized);
        return undefined;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    },
  });
  if (prompts.isCancel(baseUrl) || baseUrl === "back") {
    return { action: allowBack ? "back" : "cancel" };
  }
  const normalizedBaseUrl = validCustomPrimaryProviderBaseUrl(String(baseUrl).trim());
  let currentUpstreamWireApi = "responses";
  let upstreamMetadataUnreadable = false;
  if (custom && editingProviderId !== undefined) {
    try {
      currentUpstreamWireApi = readCustomProviderUpstreamWireApi(environment, editingProviderId);
    } catch {
      upstreamMetadataUnreadable = true;
    }
  }
  let chatUpstream = false;
  if (custom) {
    if (upstreamMetadataUnreadable) {
      output.write("\n已保存的上游接口无法安全读取；请重新选择，保存会覆盖该元数据。\n");
    }
    const upstreamWireApi = await prompts.select({
      message: "上游接口",
      options: [
        { value: "responses", label: "Responses", hint: "上游提供 /v1/responses，网关直连；客户端检索要求上游支持" },
        { value: "chat_completions", label: "Chat Completions", hint: "上游提供 /v1/chat/completions，网关转换；客户端检索由网关适配" },
      ],
      initialValue: currentUpstreamWireApi,
    });
    if (prompts.isCancel(upstreamWireApi) || upstreamWireApi === "back") {
      return { action: allowBack ? "back" : "cancel" };
    }
    chatUpstream = upstreamWireApi === "chat_completions";
  }
  let normalizedId = fixedProviderId;
  if (normalizedId === undefined) {
    const derivedProviderId = customPrimaryProviderIdFromBaseUrl(normalizedBaseUrl, custom ? "custom" : "official", environment);
    const providerId = await prompts.select({
      message: "Provider ID",
      options: [
        {
          value: derivedProviderId,
          label: derivedProviderId,
          hint: "从上游 URL 主机名提取",
        },
        ...(!custom ? [{
          value: primaryProviderId,
          label: `${primaryProviderId}（推荐；允许 Codex 使用远程压缩）`,
          hint: "上游仍需兼容远程压缩接口",
        }] : []),
        {
          value: "__custom__",
          label: "自定义标识符",
          hint: "不使用上游地址作为 Provider ID",
        },
      ],
      initialValue: custom || effectiveActiveProviderId === derivedProviderId ? derivedProviderId : primaryProviderId,
    });
    if (prompts.isCancel(providerId) || providerId === "back") {
      return { action: allowBack ? "back" : "cancel" };
    }
    if (providerId === "__custom__") {
      const customId = await prompts.text({
        message: custom ? "Provider ID（必须以 cp- 开头）" : "自定义 Provider ID",
        validate: (value) => validateCustomPrimaryModelProviderId(String(value).trim(), environment)
          ?? (custom !== isCustomCatalogProvider(String(value).trim())
            ? "自定义提供商必须使用 cp- 前缀；Codex 兼容 Provider 不使用该前缀" : undefined),
      });
      if (prompts.isCancel(customId) || customId === "back") {
        return { action: allowBack ? "back" : "cancel" };
      }
      normalizedId = String(customId).trim();
    } else {
      normalizedId = String(providerId);
    }
    if (normalizedId === "") return { action: allowBack ? "back" : "cancel" };
    const customIdValidationError = validateCustomPrimaryModelProviderId(normalizedId, environment);
    if (customIdValidationError !== null) throw new Error(customIdValidationError);
    const configured = Object.prototype.hasOwnProperty.call(currentProviders, normalizedId)
      || switchingProviders.some(({ id }) => id === normalizedId);
    const backedUp = !configured
      && Object.prototype.hasOwnProperty.call(
        readPrimaryProviderBackup(environment),
        normalizedId,
      );
    if (configured || backedUp) {
      output.write(`Provider ID ${normalizedId} 已存在，请使用“编辑”。\n`);
      return undefined;
    }
  }

  let normalizedName = primaryProviderId;
  if (normalizedId !== primaryProviderId) {
    const name = await prompts.text({
      message: "显示名称",
      initialValue: currentName || normalizedId,
      validate: (value) => String(value).trim() === "" ? "显示名称不能为空" : undefined,
    });
    if (prompts.isCancel(name) || name === "back") {
      return { action: allowBack ? "back" : "cancel" };
    }
    normalizedName = String(name).trim();
  }

  const mode = await prompts.select({
    message: "运行模式",
    options: modeOptions(),
    initialValue: switchingProvider?.id === normalizedId
      || (fixedProviderId === undefined && hasOfficialMainProvider)
      ? "switching"
      : "exclusive",
  });
  if (prompts.isCancel(mode) || mode === "back") {
    return { action: allowBack ? "back" : "cancel" };
  }
  if (
    mode === "switching"
    && effectiveActiveProviderId !== undefined
    && effectiveActiveProviderId !== "openai"
  ) {
    throw new Error(
      `当前固定主 Provider ${effectiveActiveProviderId} 必须先切回官方 OpenAI，才能启用自定义切换模式`,
    );
  }
  if (mode === "switching" && fixedProviderFromConfig) {
    throw new Error(
      "自定义切换模式不修改主配置；请先运行 codexc provider switch openai 将主配置候选移入私有备份，再重新编辑",
    );
  }
  if (mode === "exclusive") {
    if (!hasOfficialMainProvider && !hasCustomFixedMainProvider) {
      throw new Error(
        `当前受管固定 Provider ${effectiveActiveProviderId} 必须先恢复官方模式，才能配置自定义固定 Provider`,
      );
    }
    const otherSwitchingProviderIds = switchingProviders
      .map(({ id }) => id)
      .filter((id) => id !== normalizedId);
    if (otherSwitchingProviderIds.length > 0) {
      throw new Error(
        `固定模式不能保留其他自定义切换 Provider；请先删除其他自定义切换 Provider：${otherSwitchingProviderIds.join("、")}`,
      );
    }
  }

  if (mode === "switching" && hasTopLevelBaseUrl) {
    throw new Error(
      "自定义切换模式不会修改主配置；请先移除主配置中的 openai_base_url",
    );
  }
  const removesTopLevelBaseUrl = mode === "exclusive" && hasTopLevelBaseUrl;
  if (removesTopLevelBaseUrl) {
    output.write(
      "检测到顶层 openai_base_url：固定模式写入前必须移除该旧地址。\n",
    );
    const removeConfirmed = await prompts.confirm({
      message: "是否移除顶层 openai_base_url？",
      initialValue: true,
    });
    if (prompts.isCancel(removeConfirmed) || removeConfirmed !== true) {
      output.write("已取消，未修改配置。\n");
      return undefined;
    }
  }

  if (previousCatalog?.definitions.length) {
    output.write("模板导入仅新增模型；已有模型的模板更新请从模型管理选择“对比并更新模型模板”。本向导仍可手动编辑已有模型参数。\n");
  }
  const imported = custom ? await promptResponsesModelImport(prompts, previousCatalog?.definitions, loadModelTemplates) : [];
  if (imported === undefined) return { action: allowBack ? "back" : "cancel" };
  const definitions = [...(previousCatalog?.definitions ?? [])];
  const definitionIds = new Set(definitions.map(entry => entry.id));
  for (const entry of imported) {
    if (definitionIds.has(entry.id)) {
      throw new Error("模板导入的平台模型 ID 与已有模型或本次导入重复；已有模型的模板更新请使用模型管理中的“对比并更新模型模板”");
    }
    definitionIds.add(entry.id);
    definitions.push(entry);
  }
  let selectedModel;
  if (imported.length > 0) {
    selectedModel = await prompts.select({
      message: "选择默认模型",
      options: [...definitions.map(entry => ({value: entry.id, label: `${entry.name}（${entry.id}）`})), {value:"__manual__",label:"手动添加其他模型"}],
      initialValue: currentModel ?? previousCatalog?.defaultModel ?? imported[0].id,
    });
    if (prompts.isCancel(selectedModel)) return { action: allowBack ? "back" : "cancel" };
  }
  const model = selectedModel && selectedModel !== "__manual__" ? selectedModel : await prompts.text({
    message: custom ? "默认模型 ID（平台提供的准确名称）" : "上游模型 ID（必须存在于 Codex 官方模型目录）",
    initialValue: currentModel ?? previousCatalog?.defaultModel ?? "",
    validate: (value) => {
      const normalized = String(value).trim();
      if (normalized === "") return "模型 ID 不能为空";
      return custom || officialModelIds.has(normalized)
        ? undefined
        : "模型 ID 不在 Codex 官方模型目录中";
    },
  });
  if (prompts.isCancel(model) || model === "back") {
    return { action: allowBack ? "back" : "cancel" };
  }
  const normalizedModel = String(model).trim();
  if (!custom && !officialModelIds.has(normalizedModel)) {
    throw new Error(`模型 ID 不在 Codex 官方模型目录中：${normalizedModel}`);
  }

  const models = custom ? await promptResponsesModels(prompts, normalizedModel, definitions, imported.map(entry => entry.id), output, chatUpstream ? "chat_completions" : "responses", previousCatalog?.definitions.map(entry => entry.id) ?? []) : undefined;
  if (custom && models === undefined) return { action: allowBack ? "back" : "cancel" };

  const canPreserveCurrentBearerToken = hasCurrentBearerToken
    && customPrimaryProviderUrlsShareOrigin(currentBaseUrl, normalizedBaseUrl);
  const bearerTokenInput = await prompts.password({
    message: canPreserveCurrentBearerToken
      ? "API Key（留空保留当前 Key；不回显）"
      : mode === "switching"
        ? `API Key（明文写入 0600 的 ~/.codex/${customSwitchingProviderProfileName(normalizedId)}.config.toml；不回显）`
        : "API Key（明文写入当前用户私有凭据文件；主配置只保存 env_key 引用；不回显）",
    validate: (value) => String(value).trim() === "" && !canPreserveCurrentBearerToken
      ? "API Key 不能为空"
      : undefined,
  });
  if (prompts.isCancel(bearerTokenInput) || bearerTokenInput === "back") {
    return { action: allowBack ? "back" : "cancel" };
  }
  const replacementApiKey = String(bearerTokenInput).trim();
  if (replacementApiKey === "" && !canPreserveCurrentBearerToken) {
    throw new Error("API Key 不能为空");
  }

  let catalogModels = models;
  let probeConnections;
  if (custom) {
    const selected = await promptCustomModelCapabilities(prompts, {
      baseUrl: normalizedBaseUrl, apiKey: replacementApiKey || currentApiKey, models,
      upstreamWireApi: chatUpstream ? "chat_completions" : "responses", environment,
    }, { output, probe: probeModelCapabilities });
    if (selected === undefined) {
      output.write("已取消，未修改配置。\n");
      return { action: allowBack ? "back" : "cancel" };
    }
    catalogModels = selected.models;
    probeConnections = selected.probeConnections;
  }

  const supportsWebsockets = chatUpstream
    ? false
    : custom ? await prompts.confirm({ message: "是否支持 Responses WebSocket？（不检测，按平台说明选择）", initialValue: currentWebsockets === "yes" })
    : await promptResponsesWebSocket(prompts, {
        baseUrl: normalizedBaseUrl,
        apiKey: replacementApiKey || currentApiKey,
        model: normalizedModel,
        reasoningEffort: custom ? models.find(entry => entry.id === normalizedModel)?.defaultReasoningEffort ?? "none" : "medium",
        environment,
      }, {output, probe: probeWebSocket, current: currentWebsockets === "yes"});
  if (supportsWebsockets === undefined || prompts.isCancel(supportsWebsockets)) return { action: allowBack ? "back" : "cancel" };

  const saveInput = {
    operation: fixedProviderId === undefined ? "create" : "update",
    providerId: normalizedId,
    name: normalizedName,
    baseUrl: normalizedBaseUrl,
    mode,
    model: normalizedModel,
    ...(custom ? { catalog: { kind: "custom", models: catalogModels } } : {}),
    supportsWebsockets,
    upstreamWireApi: chatUpstream ? "chat_completions" : "responses",
    ...(probeConnections?.length ? { probeConnections } : {}),
    credential: replacementApiKey === ""
      ? { action: "preserve" }
      : { action: "replace", apiKey: replacementApiKey },
    confirmRemoveTopLevelBaseUrl: removesTopLevelBaseUrl,
  };
  const prepared = await prepareCustomPrimaryProviderSave(saveInput, {
    environment,
    createClient,
    loadContext: async () => ({ snapshot, officialModels }),
  });
  const preview = prepared.preview;
  const previewModelDetails = custom ? compileResponsesModelCatalog(preview.provider.models, preview.provider.model).models : [];
  output.write(preview.provider.mode === "switching"
    ? `\n将写入 ~/.codex/${customSwitchingProviderProfileName(normalizedId)}.config.toml：\n`
    : "\n将写入 ~/.codex/config.toml：\n");
  const previewLines = [
    `- Provider ID：${preview.provider.id}`,
    `- 显示名称：${preview.provider.displayName}`,
    `- 上游：${preview.provider.baseUrl}`,
    `- 上游接口：${preview.provider.upstreamWireApi === "chat_completions" ? "Chat Completions（网关转换）" : "Responses（直连）"}`,
    `- 默认模型：${preview.provider.model}`,
    `- 运行模式：${preview.provider.mode === "switching" ? "OpenAI + 自定义切换" : "仅自定义固定"}`,
    `- 模型目录：${custom ? "自定义；仅声明的模型与能力" : "Codex 官方"}`,
    ...(preview.provider.mode === "switching"
      ? [
          "- 主配置：保持官方 OpenAI",
          `- 默认思考等级：${custom ? models.find(entry => entry.id === normalizedModel).defaultReasoningEffort ?? "none" : "medium"}`,
          "- 服务层级：default",
          "- 认证：API Key 将明文写入 0600 私有 Profile（不回显、不进入命令行和日志）",
        ]
      : [
          "- 主配置：写入并启用该固定 Provider",
          "- 认证：API Key 将明文写入当前用户私有凭据文件，主配置仅保存 env_key 引用（不回显、不进入命令行和日志）",
        ]),
    ...(custom ? preview.provider.models.flatMap((entry, index) => [
      `- 模型 ${entry.id}：${entry.contextWindow} Token；最大窗口 ${entry.maxContextWindow ?? entry.contextWindow} Token；图片${entry.supportsImages ? "声明支持" : "不声明"}；图片 original ${entry.supportsImageDetailOriginal ? "声明支持" : "不声明"}；apply_patch ${entry.applyPatchToolType === "freeform" ? "freeform" : "不声明"}；思考 ${entry.reasoningEfforts.join("/") || "无可选等级"}；默认 ${entry.defaultReasoningEffort ?? "none"}${entry.template ? `；模板 ${entry.template.source}/${entry.template.model}` : ""}`,
      `  模型描述：${JSON.stringify(previewModelDetails[index].description)}`,
      `  思考等级说明：${entry.reasoningEfforts.map(effort => `${effort}=${JSON.stringify(entry.reasoningDescriptions?.[effort] ?? effort)}`).join("；") || "无可选等级"}`,
      `  回答详细程度：${entry.supportsVerbosity ? `声明支持；默认 ${entry.defaultVerbosity}` : "不声明"}；思考摘要：${entry.supportsReasoningSummary ? `声明支持；默认 ${entry.defaultReasoningSummary ?? "Codex 默认"}` : "不声明"}`,
      `  默认采样参数：${entry.sampling === undefined ? "上游默认值（不发送参数）" : JSON.stringify(entry.sampling)}；请求显式参数优先`,
      `  有效上下文：${entry.effectiveContextWindowPercent ?? 95}%；自动压缩阈值：${entry.autoCompactTokenLimit === undefined ? "Codex 默认" : `${entry.autoCompactTokenLimit} Token`}；工具输出截断：${entry.truncationPolicy === undefined ? `${Math.min(10_000, Math.floor(entry.contextWindow / 4))} tokens（目录默认）` : `${entry.truncationPolicy.limit} ${entry.truncationPolicy.mode}`}`,
      `  模型指令（完整内容）：${JSON.stringify(previewModelDetails[index].model_messages.instructions_template)}`,
    ]) : []),
    `- WebSocket：${preview.provider.supportsWebsockets ? "是" : "否"}`,
    ...(custom
        ? preview.provider.models.map(entry => `- 模型 ${entry.id} 工具检索（tool_search）：${entry.supportsSearchTool ? chatUpstream ? "声明支持；网关转换检索输入项" : "声明支持；上游须接受 Codex 检索输入项" : "不声明；工具定义全量下发"}`)
      : []),
    ...(preview.transport.cleartext ? ["- 传输：明文 HTTP；API Key 与请求内容不加密"] : []),
  ];
  if (preview.provider.id === primaryProviderId) {
    previewLines.push("- 远程压缩：允许 Codex 使用；上游必须兼容对应接口");
  }
  output.write(previewLines.map((line) => `${line}\n`).join(""));

  const confirmed = await prompts.confirm({
    message: "确认写入？",
    initialValue: true,
  });
  if (prompts.isCancel(confirmed) || confirmed !== true) {
    output.write("已取消，未修改配置。\n");
    return undefined;
  }

  const result = await prepared.apply();
  const backupCleanupFailed = result.warnings.some(
    ({ code }) => code === "backup-cleanup-failed",
  );
  if (result.provider.mode === "switching") {
    output.write(
      backupCleanupFailed
        ? `配置已写入，但自定义主 Provider ${result.provider.id} 的私有备份清理失败；`
          + "请修复私有备份权限后重试切换或删除。\n"
        : "配置已写入。\n",
    );
    writeGatewayConfigActivationNotice(output, environment, configActivationResult("restart-all"));
    output.write(
      "旧 Thread 不会改变；重启后，在 /model 选择该 Provider，"
      + "下一条消息会创建新的 Provider Thread。可用 /model clear 清除会话偏好。\n",
    );
    return {
      provider: result.provider.id,
      model: result.provider.model,
      activation: "restart-all",
      activationResult: configActivationResult("restart-all"),
    };
  }
  output.write(
    backupCleanupFailed
      ? `配置已写入，但自定义主 Provider ${result.provider.id} 的私有备份清理失败；`
        + "请修复私有备份权限后重试切换或删除。\n"
      : "配置已写入。\n",
  );
  writeGatewayConfigActivationNotice(output, environment, configActivationResult("restart-all"));
  output.write(
    "旧 Thread 不会改变；重启后新 Thread 使用该固定 Provider。"
    + "会话内 /model 偏好可用 /model clear 清除。\n",
  );
  return {
    provider: result.provider.id,
    model: result.provider.model,
    activation: "restart-all",
    activationResult: configActivationResult("restart-all"),
  };
}
