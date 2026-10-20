import { createHash } from "node:crypto";
import { officialTuiClientVersion, resolveCodexRequestIdentity } from "../runtime/codex-request-identity.mjs";
import { readFileSync, unlinkSync } from "node:fs";

import {
  GatewayConfigConflictError,
  GatewayConfigValidationError,
  parseGatewayConfig,
  validateCodexConfigDocument,
  validateDebugConfigDocument,
  validateGatewayConfigStructureDocument,
  validateGatewayProcessConfigDocument,
  writeGatewayConfig,
} from "../runtime/gateway-config.mjs";
import { readCodexProxySnapshot, renderCodexProxySettings, validateCodexProxyValue, writeCodexProxySnapshot } from "../runtime/codex-proxy-env.mjs";
import { writePrivateFileAtomicSync } from "../runtime/private-file.mjs";
import { validateModelDisplayAliases } from "../runtime/model-display-name.mjs";
import { invalidSetting } from "./config-management-error.mjs";
import { configActivationResult } from "./config-activation-result.mjs";
import {
  applyMetricsSetting,
  projectMetricsSettings,
} from "./config-metrics-management.mjs";
import { gatewayChannelStates } from "./config-summary.mjs";
import {
  applyWebuiSetting,
  projectWebuiSettings,
} from "./config-webui-management.mjs";
import { detectTerminalIdentity } from "../runtime/terminal-identity.mjs";
import { requireUserConfig } from "./runtime-config.mjs";

const operationUpdateValues = ["full", "compact", "hidden"];
const messageFormatValues = ["html", "rich"];
const loggingLevelValues = ["fatal", "error", "warn", "info", "debug", "trace"];
const proxyFields = ["http_proxy", "https_proxy", "all_proxy", "no_proxy"];

export { ConfigManagementError } from "./config-management-error.mjs";

export function loadGatewaySettings(environment = process.env) {
  const { configPath } = requireUserConfig(environment);
  const snapshot = readConfigSnapshot(configPath, readFileSync, environment);
  const document = snapshot.document;
  const effective = snapshot.effective;
  const display = effective.display;
  const codex = table(document.codex);
  const gateway = table(document.gateway);
  const requestIdentity = resolveCodexRequestIdentity(codex);
  const clientIdentity = table(requestIdentity.clientIdentity);
  const approval = effective.approval;
  const conversation = effective.conversation;
  const scheduledTasks = effective.scheduled_tasks;
  const logging = effective.logging;
  const debug = effective.debug ?? validateDebugConfigDocument({});
  const network = snapshot.proxy.settings;
  const telegram = table(document.telegram);
  const workspaces = workspaceOptions(document);
  return {
    configPath,
    revision: snapshot.revision,
    display: {
      operationUpdates: display.operation_updates,
      planUpdatesEnabled: display.plan_updates,
      reasoningEnabled: display.reasoning,
      modelAliases: display.model_aliases ?? {},
    },
    system: {
      approvalTimeoutSeconds: approval.timeout_seconds,
      idleReleaseMinutes: conversation.idle_release_minutes,
      defaultWorkspace: stringValue(document.default_workspace) || null,
      defaultModel: stringValue(codex.default_model) || null,
      modelTrafficMode: debug.model_traffic_input_items === 0 && debug.model_traffic_item_max_bytes === 0 ? "debug" : "production",
      modelTrafficDumpEnabled: debug.model_traffic_dump,
      modelTrafficRetentionDays: debug.model_traffic_retention_days,
      officialTuiIdentity: {
        followCliVersion: codex.follow_cli_version === true,
        clientIdentity: {
          name: stringValue(clientIdentity.name) || null,
          title: stringValue(clientIdentity.title) || null,
          version: stringValue(clientIdentity.version) || null,
        },
        upstreamUserAgent: requestIdentity.upstreamUserAgent ?? null,
        terminalIdentity: typeof codex.terminal_identity === "string"
          ? codex.terminal_identity
          : null,
        defaults: officialTuiIdentityDefaults(),
      },
      appServerTimezone: typeof codex.timezone === "string" ? codex.timezone : null,
      gatewayTimezone: typeof gateway.timezone === "string" ? gateway.timezone : null,
      workspaces,
    },
    automation: {
      scheduledTasksEnabled: scheduledTasks.enabled,
    },
    network: Object.fromEntries(proxyFields.map((field) => [
      field,
      { configured: stringValue(network[field]) !== "" },
    ])),
    advanced: {
      loggingLevel: logging.level,
    },
    telegram: {
      configured: stringValue(telegram.bot_token) !== "",
      messageFormat: effective.telegram?.message_format ?? "html",
    },
    webui: projectWebuiSettings(document),
    metrics: projectMetricsSettings(effective),
    channels: gatewayChannelStates(document),
  };
}

export function updateGatewaySetting(
  input,
  {
    environment = process.env,
    expectedRevision,
    readConfig = readFileSync,
    writeConfig = writeGatewayConfig,
    writeProxyConfig = (_path, content, snapshot) => writeCodexProxySnapshot(snapshot, content),
    skipBackup = false,
  } = {},
) {
  const { configPath } = requireUserConfig(environment);
  assertExpectedRevision(expectedRevision);
  const snapshot = readConfigSnapshot(configPath, readConfig, environment);
  if (snapshot.revision !== expectedRevision) {
    throw invalid("revision", "stale-revision", "Gateway 配置已变化，请重新读取设置");
  }
  const document = snapshot.document;
  if (input?.kind === "network.proxy" || input?.kind === "network.proxy-batch") {
    const proxySnapshot = snapshot.proxy;
    const network = proxySnapshot.settings;
    const proxyDocument = { network: { ...network } };
    const result = input.kind === "network.proxy"
      ? applyNetworkProxy(proxyDocument, input) : applyNetworkProxyBatch(proxyDocument, input);
    const values = {};
    for (const field of proxyFields) {
      if (network[field] !== proxyDocument.network?.[field]) {
        values[field] = proxyDocument.network?.[field] ?? null;
      }
    }
    const content = renderCodexProxySettings(proxySnapshot, values);
    const modified = content !== (proxySnapshot.content ?? "");
    if (modified) {
      try {
        writeProxyConfig(proxySnapshot.path, content, proxySnapshot);
      } catch (error) {
        if (error instanceof GatewayConfigConflictError) {
          throw invalid("revision", "stale-revision", "Codex .env 已变化或正在写入，请重新读取设置");
        }
        throw error;
      }
    }
    const activation = modified ? "restart-all" : "none";
    return {
      kind: input.kind, configPath: proxySnapshot.path, previousRevision: snapshot.revision,
      value: result.value, activation, activationResult: configActivationResult(activation),
    };
  }
  const originalDocument = structuredClone(document);
  const result = applySetting(document, input);
  validateGatewayConfigStructureDocument(document);
  if (JSON.stringify(document) === JSON.stringify(originalDocument)) {
    return {
      kind: input.kind,
      configPath,
      previousRevision: snapshot.revision,
      value: result.value,
      activation: "none",
      activationResult: configActivationResult("none"),
      ...(result.generatedTokens === undefined ? {} : { generatedTokens: result.generatedTokens }),
    };
  }
  if (readConfig(configPath, "utf8") !== snapshot.content) {
    throw invalid("revision", "stale-revision", "Gateway 配置已变化，请重新读取设置");
  }
  const backupPath = result.backupRequired && !skipBackup
    ? writeConfigBackup(configPath, snapshot.content)
    : null;
  try {
    writeConfig(configPath, document);
  } catch (error) {
    if (backupPath !== null) {
      try {
        unlinkSync(backupPath);
      } catch (cleanupError) {
        if (cleanupError?.code !== "ENOENT") {
          throw new AggregateError(
            [error, cleanupError],
            "Gateway 配置写入和备份清理均失败",
            { cause: cleanupError },
          );
        }
      }
    }
    if (error instanceof GatewayConfigConflictError) {
      throw invalid("revision", "stale-revision", "Gateway 配置已变化，请重新读取设置");
    }
    throw error;
  }
  return {
    kind: input.kind,
    configPath,
    previousRevision: snapshot.revision,
    value: result.value,
    activation: result.activation,
    activationResult: configActivationResult(result.activation),
    ...(result.generatedTokens === undefined ? {} : { generatedTokens: result.generatedTokens }),
    ...(backupPath === null ? {} : { backupPath }),
  };
}

/**
 * 按运行命令的终端补入缺失的 `[codex].terminal_identity`：App Server 由服务进程启动、自身没有
 * 终端，只有运行安装或更新命令的终端能探测到用户实际使用的终端。已配置或探测不到终端时不做
 * 修改，返回未写入时的 `null`，调用方据此决定是否提示；`codexc config` 与 WebUI 直接在预填
 * 中使用同一探测结果，不走这里。
 */
export function applyTerminalIdentityFromEnvironment(environment = process.env) {
  const terminalIdentity = detectTerminalIdentity(environment);
  if (terminalIdentity === null) return null;
  const settings = loadGatewaySettings(environment);
  const { clientIdentity, upstreamUserAgent, followCliVersion, terminalIdentity: configured } =
    settings.system.officialTuiIdentity;
  if (configured !== null) return null;
  const result = updateGatewaySetting({
    kind: "system.official-tui-identity",
    value: { clientIdentity, upstreamUserAgent, terminalIdentity, followCliVersion },
  }, { environment, expectedRevision: settings.revision });
  return result.value.terminalIdentity;
}

export function validateNetworkProxyValue(field, value) {
  if (!proxyFields.includes(field)) return `未知网络代理字段：${String(field)}`;
  const normalized = stringValue(value);
  if (!normalized) return undefined;
  return field === "no_proxy" ? validateNoProxy(normalized) : validateCodexProxyValue(field, normalized);
}

/** 已配置 bot_token 的 Telegram 才会创建 Surface；只留空表时没有消费者。 */
function telegramSurfaceEnabled(document) {
  return stringValue(table(document.telegram).bot_token) !== "";
}

/**
 * 只有 Telegram（已配置 bot_token）与已启用的飞书消费 `display.*` 设置，与运行时重载判定
 * （`classifyConfigReload`）保持一致：只启用微信或未配置渠道时改这些设置没有渠道受影响，
 * 无需重建 Gateway 连接，只需重新读取配置。
 */
function displaySettingActivation(document) {
  return telegramSurfaceEnabled(document) || table(document.feishu).enabled === true
    ? "restart-gateway"
    : "reload";
}

function applySetting(document, input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw invalid("input", "invalid-input", "设置输入必须是对象");
  }
  const delegated = applyWebuiSetting(document, input)
    ?? applyMetricsSetting(document, input);
  if (delegated !== undefined) return delegated;
  switch (input.kind) {
    case "display.operation-updates": {
      const value = enumValue(input.value, operationUpdateValues, "value", "操作详情显示");
      document.display = { ...table(document.display), operation_updates: value };
      return changed(value, displaySettingActivation(document));
    }
    case "display.plan-updates": {
      const value = booleanValue(input.value, "value", "计划更新显示");
      document.display = { ...table(document.display), plan_updates: value };
      return changed(value, displaySettingActivation(document));
    }
    case "display.reasoning": {
      const value = booleanValue(input.value, "value", "思考状态显示");
      document.display = { ...table(document.display), reasoning: value };
      return changed(value, displaySettingActivation(document));
    }
    case "display.model-aliases": {
      let value;
      try {
        value = validateModelDisplayAliases(input.value);
      } catch (error) {
        throw Object.assign(invalid("value", "invalid-model-aliases", error.message), { cause: error });
      }
      document.display = { ...table(document.display), model_aliases: value };
      return { value, activation: "next-read", backupRequired: true };
    }
    case "telegram.message-format": {
      const value = enumValue(input.value, messageFormatValues, "value", "Telegram 消息格式");
      document.telegram = { ...table(document.telegram), message_format: value };
      return changed(value, telegramSurfaceEnabled(document) ? "restart-gateway" : "reload");
    }
    case "system.approval-timeout": {
      const value = integerValue(input.value, 30, 3_600, "value", "审批超时");
      document.approval = { ...table(document.approval), timeout_seconds: value };
      return changed(value, "restart-gateway");
    }
    case "system.idle-release-minutes": {
      const value = integerValue(input.value, 0, 1_440, "value", "会话空闲自动解除");
      document.conversation = {
        ...table(document.conversation),
        idle_release_minutes: value,
      };
      return changed(value, "restart-gateway");
    }
    case "system.default-workspace": {
      const value = requiredString(input.value, "value", "默认工作区");
      if (!workspaceOptions(document).some((workspace) => workspace.id === value)) {
        throw invalid("value", "unknown-workspace", `找不到默认工作区：${value}`);
      }
      document.default_workspace = value;
      return changed(value, "restart-gateway");
    }
    case "system.default-model": {
      const value = optionalString(input.value, 256, "value", "模型 ID");
      const codex = { ...table(document.codex) };
      if (value === null) delete codex.default_model;
      else codex.default_model = value;
      document.codex = codex;
      return changed(value, "restart-gateway");
    }
    case "system.model-traffic-dump": {
      const value = booleanValue(input.value, "value", "调用详情记录");
      document.debug = { ...table(document.debug), model_traffic_dump: value };
      return changed(value, "restart-app-server");
    }
    case "system.model-traffic-mode": {
      const value = enumValue(input.value, ["production", "debug"], "value", "调用记录模式");
      document.debug = { ...table(document.debug), model_traffic_input_items: value === "debug" ? 0 : 3,
        model_traffic_item_max_bytes: value === "debug" ? 0 : 65536 };
      return changed(value, "restart-app-server");
    }
    case "system.model-traffic-retention-days": {
      const value = integerValue(input.value, 0, 36_500, "value", "调用记录保留天数");
      document.debug = { ...table(document.debug), model_traffic_retention_days: value };
      return changed(value, "restart-app-server");
    }
    case "system.official-tui-identity": {
      const followCliVersion = booleanValue(input.value?.followCliVersion, "value.followCliVersion", "跟随 CLI 版本");
      const identity = table(input.value?.clientIdentity);
      const name = optionalStrictString(
        identity.name,
        64,
        "value.clientIdentity.name",
        "客户端身份名称",
      );
      const title = optionalString(
        identity.title,
        128,
        "value.clientIdentity.title",
        "客户端身份标题",
      );
      const version = optionalStrictString(
        identity.version,
        64,
        "value.clientIdentity.version",
        "客户端身份版本",
      );
      const clientIdentity = name || title || version
        ? {
            ...(name ? { name } : {}),
            ...(title ? { title } : {}),
            ...(version ? { version } : {}),
          }
        : null;
      const upstreamValue = input.value?.upstreamUserAgent;
      const upstreamUserAgent =
        upstreamValue === null || upstreamValue === undefined || upstreamValue === ""
          ? null
          : upstreamValue;
      if (typeof upstreamUserAgent === "string" && upstreamUserAgent.length > 512) {
        throw invalid(
          "value.upstreamUserAgent",
          "too-long",
          "上游 User-Agent 长度不能超过 512 个字符",
        );
      }
      const terminalIdentity = optionalStrictString(
        input.value?.terminalIdentity,
        64,
        "value.terminalIdentity",
        "终端标识",
      );
      const codex = { ...table(document.codex) };
      codex.follow_cli_version = followCliVersion;
      if (clientIdentity === null) delete codex.client_identity;
      else codex.client_identity = clientIdentity;
      if (upstreamUserAgent === null) delete codex.upstream_user_agent;
      else codex.upstream_user_agent = upstreamUserAgent;
      if (terminalIdentity === null) delete codex.terminal_identity;
      else codex.terminal_identity = terminalIdentity;
      document.codex = validateSettingDocument(codex, validateCodexConfigDocument, {
        "client_identity.name": ["value.clientIdentity.name", "客户端名称格式无效；跟随 CLI 版本时必须为 codex-tui"],
        "client_identity.title": ["value.clientIdentity.title", "客户端标题格式无效"],
        "client_identity.version": ["value.clientIdentity.version", "客户端版本格式无效"],
        upstream_user_agent: ["value.upstreamUserAgent", "上游 User-Agent 格式无效；跟随 CLI 版本时请使用完整官方 TUI UA"],
        terminal_identity: ["value.terminalIdentity", "终端标识须为终端名或终端名/版本，仅允许字母、数字、.、_、-，且以字母或数字开头"],
      });
      const effective = resolveCodexRequestIdentity(document.codex);
      if (effective.upstreamUserAgent !== undefined && effective.upstreamUserAgent.length > 512) {
        throw invalid("value.upstreamUserAgent", "too-long", "上游 User-Agent 更新 Codex 版本后超过 512 个字符，请缩短系统或终端信息");
      }
      if (effective.clientIdentity) document.codex.client_identity = effective.clientIdentity;
      if (effective.upstreamUserAgent !== undefined) document.codex.upstream_user_agent = effective.upstreamUserAgent;
      return changed(
        {
          followCliVersion,
          clientIdentity: effective.clientIdentity ?? null,
          upstreamUserAgent: effective.upstreamUserAgent ?? null,
          terminalIdentity,
        },
        "restart-all",
      );
    }
    case "system.app-server-timezone": {
      const timezone = optionalStrictString(
        input.value,
        64,
        "value",
        "时区",
      );
      const codex = { ...table(document.codex) };
      if (timezone === null) delete codex.timezone;
      else codex.timezone = timezone;
      document.codex = validateSettingDocument(codex, validateCodexConfigDocument, {
        timezone: ["value", "时区必须是有效的 IANA 名称"],
      });
      return changed(timezone, "restart-app-server-gateway-webui");
    }
    case "system.gateway-timezone": {
      const timezone = optionalStrictString(input.value, 64, "value", "网关时区");
      const gateway = { ...table(document.gateway) };
      if (timezone === null) delete gateway.timezone;
      else gateway.timezone = timezone;
      const validated = validateSettingDocument(gateway, validateGatewayProcessConfigDocument, {
        timezone: ["value", "网关时区必须是 system 或 Node.js 支持的 IANA 名称"],
      });
      if (timezone === null) delete document.gateway;
      else document.gateway = validated;
      return changed(timezone, "restart-gateway");
    }
    case "automation.scheduled-tasks": {
      const value = booleanValue(input.value, "value", "计划任务");
      document.scheduled_tasks = { ...table(document.scheduled_tasks), enabled: value };
      return changed(value, "restart-gateway");
    }
    case "advanced.logging-level": {
      const value = enumValue(input.value, loggingLevelValues, "value", "日志等级");
      document.logging = { ...table(document.logging), level: value };
      return changed(value, "restart-gateway");
    }
    default:
      throw invalid("kind", "unknown-setting", `未知 Gateway 设置：${String(input.kind)}`);
  }
}

// Only candidate fields owned by this operation become user input errors.
// Existing-document validation and I/O remain outside this boundary.
function validateSettingDocument(document, validate, fields) {
  try {
    return validate(document);
  } catch (error) {
    if (!(error instanceof GatewayConfigValidationError) || error.issues.length === 0
      || error.issues.some(issue => !Object.hasOwn(fields, issue.path.join(".")))) throw error;
    const issue = error.issues[0];
    const [field, message] = fields[issue.path.join(".")];
    throw invalid(field, issue.code === "too_big" ? "too-long" : "invalid-value", message);
  }
}

function applyNetworkProxy(document, input) {
  const field = enumValue(input.field, proxyFields, "field", "网络代理字段");
  const action = enumValue(input.action, ["set", "clear"], "action", "网络代理操作");
  const network = { ...table(document.network) };
  if (action === "clear") {
    delete network[field];
  } else {
    const value = requiredString(input.value, "value", field === "no_proxy" ? "NO_PROXY" : "代理 URL");
    const validation = validateNetworkProxyValue(field, value);
    if (validation !== undefined) throw invalid("value", "invalid-proxy", validation);
    network[field] = value;
  }
  if (Object.keys(network).length === 0) delete document.network;
  else document.network = network;
  return {
    value: { field, configured: action === "set" },
    activation: "reinstall-services",
  };
}

function applyNetworkProxyBatch(document, input) {
  if (!input.values || typeof input.values !== "object" || Array.isArray(input.values)) {
    throw invalid("values", "invalid-input", "批量代理设置必须是对象");
  }
  const network = { ...table(document.network) };
  const fields = ["http_proxy", "https_proxy", "all_proxy"];
  const unknown = Object.keys(input.values).find((field) => !fields.includes(field));
  if (unknown !== undefined) {
    throw invalid(`values.${unknown}`, "unknown-field", `批量代理字段无效：${unknown}`);
  }
  for (const field of fields) {
    if (!Object.prototype.hasOwnProperty.call(input.values, field)) continue;
    const value = input.values[field];
    if (value === null || stringValue(value) === "") {
      delete network[field];
      continue;
    }
    const normalized = requiredString(value, `values.${field}`, "代理 URL");
    const validation = validateNetworkProxyValue(field, normalized);
    if (validation !== undefined) throw invalid(`values.${field}`, "invalid-proxy", validation);
    network[field] = normalized;
  }
  if (Object.keys(network).length === 0) delete document.network;
  else document.network = network;
  return {
    value: {
      fields: fields.filter((field) => Object.prototype.hasOwnProperty.call(input.values, field)),
    },
    activation: "reinstall-services",
  };
}

function changed(value, activation) {
  return { value, activation };
}

function readConfigSnapshot(configPath, readConfig = readFileSync, environment = process.env) {
  const content = readConfig(configPath, "utf8");
  const document = parseGatewayConfig(content, configPath);
  // 有效视图仅供读取；写入和 revision 仍使用原文及其来源信息。
  const effective = validateGatewayConfigStructureDocument(document);
  const proxy = readCodexProxySnapshot(environment);
  return {
    content,
    proxy,
    document,
    effective,
    revision: createHash("sha256").update(JSON.stringify([content, proxy.content])).digest("hex"),
  };
}

function writeConfigBackup(configPath, content) {
  const timestamp = new Date().toISOString().replace(/[:.]/gu, "-");
  const backupPath = `${configPath}.bak-${timestamp}`;
  writePrivateFileAtomicSync(backupPath, content);
  return backupPath;
}

function assertExpectedRevision(value) {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) {
    throw invalid("revision", "required-revision", "必须提供有效的 Gateway 配置修订值");
  }
}

function workspaceOptions(document) {
  return (Array.isArray(document.workspaces) ? document.workspaces : [])
    .map((entry) => table(entry))
    .filter((entry) => stringValue(entry.id))
    .map((entry) => ({
      id: stringValue(entry.id),
      name: stringValue(entry.name) || stringValue(entry.id),
    }));
}

/** 未配置 `[codex].client_identity` 时 Gateway 生效的官方 TUI 默认身份。 */
function officialTuiIdentityDefaults() {
  return {
    name: "codex-tui",
    version: officialTuiClientVersion,
  };
}

function validateNoProxy(value) {
  return value.length <= 4_096 && !/[\0\r\n]/u.test(value)
    ? undefined
    : "NO_PROXY 无效或过长";
}

function enumValue(value, allowed, field, label) {
  if (!allowed.includes(value)) {
    throw invalid(field, "invalid-choice", `${label}无效：${String(value)}`);
  }
  return value;
}

function booleanValue(value, field, label) {
  if (typeof value !== "boolean") {
    throw invalid(field, "invalid-boolean", `${label}必须是布尔值`);
  }
  return value;
}

function integerValue(value, minimum, maximum, field, label) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw invalid(field, "invalid-integer", `${label}必须为 ${minimum}–${maximum} 之间的整数`);
  }
  return value;
}

function requiredString(value, field, label) {
  const normalized = stringValue(value);
  if (!normalized) throw invalid(field, "required", `${label}不能为空`);
  return normalized;
}

function optionalString(value, maximum, field, label) {
  if (value === null || value === undefined || stringValue(value) === "") return null;
  const normalized = stringValue(value);
  if (normalized.length > maximum) {
    throw invalid(field, "too-long", `${label}长度不能超过 ${maximum} 个字符`);
  }
  return normalized;
}

function optionalStrictString(value, maximum, field, label) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "string" && value.length > maximum) {
    throw invalid(field, "too-long", `${label}长度不能超过 ${maximum} 个字符`);
  }
  return value;
}

function invalid(field, code, message) {
  return invalidSetting(field, code, message);
}

function stringValue(value) {
  return typeof value === "string" ? value.trim() : "";
}

function table(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
