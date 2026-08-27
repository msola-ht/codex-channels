import { createHash } from "node:crypto";
import { readFileSync, unlinkSync } from "node:fs";

import {
  GatewayConfigConflictError,
  parseGatewayConfig,
  writeGatewayConfig,
} from "../runtime/gateway-config.mjs";
import { resolveHttpProxyUrl } from "../runtime/network-proxy.mjs";
import { writePrivateFileAtomicSync } from "../runtime/private-file.mjs";
import { invalidSetting } from "./config-management-error.mjs";
import {
  applyMetricsSetting,
  projectMetricsSettings,
} from "./config-metrics-management.mjs";
import { gatewayChannelStates } from "./config-summary.mjs";
import {
  applyWebuiSetting,
  projectWebuiSettings,
} from "./config-webui-management.mjs";
import {
  applyWorkspaceSetting,
  projectWorkspaceSettings,
} from "./config-workspace-management.mjs";
import { requireUserConfig } from "./runtime-config.mjs";

const operationUpdateValues = ["full", "compact", "hidden"];
const sandboxValues = ["read-only", "workspace-write"];
const priceCurrencyValues = ["cny", "usd"];
const messageFormatValues = ["html", "rich"];
const loggingLevelValues = ["fatal", "error", "warn", "info", "debug", "trace"];
const proxyFields = ["http_proxy", "https_proxy", "all_proxy", "no_proxy"];

export { ConfigManagementError } from "./config-management-error.mjs";

export function loadGatewaySettings(environment = process.env) {
  const { configPath } = requireUserConfig(environment);
  const snapshot = readConfigSnapshot(configPath);
  const document = snapshot.document;
  const display = table(document.display);
  const codex = table(document.codex);
  const approval = table(document.approval);
  const scheduledTasks = table(document.scheduled_tasks);
  const threadSections = table(document.thread_sections);
  const logging = table(document.logging);
  const experimental = table(document.experimental);
  const network = table(document.network);
  const telegram = table(document.telegram);
  const workspaces = workspaceOptions(document);
  return {
    configPath,
    revision: snapshot.revision,
    display: {
      operationUpdates: operationUpdateValues.includes(display.operation_updates)
        ? display.operation_updates
        : "compact",
      planUpdatesEnabled: display.plan_updates !== false,
      reasoningEnabled: display.reasoning !== false,
      priceCurrency: display.price_currency === "usd" ? "usd" : "cny",
    },
    system: {
      approvalTimeoutSeconds: integerInRange(approval.timeout_seconds, 30, 3_600) ?? 300,
      sandbox: codex.sandbox === "read-only" ? "read-only" : "workspace-write",
      defaultWorkspace: stringValue(document.default_workspace) || null,
      defaultModel: stringValue(codex.default_model) || null,
      workspaces,
    },
    automation: {
      scheduledTasksEnabled: scheduledTasks.enabled === true,
      threadSectionAdministrators: stringArray(threadSections.administrators),
      threadSectionAdministratorCandidates: threadSectionAdministratorCandidates(document),
    },
    network: Object.fromEntries(proxyFields.map((field) => [
      field,
      { configured: stringValue(network[field]) !== "" },
    ])),
    advanced: {
      loggingLevel: loggingLevelValues.includes(logging.level) ? logging.level : "info",
      pluginApiEnabled: experimental.plugin_api === true,
    },
    telegram: {
      configured: stringValue(telegram.bot_token) !== "",
      messageFormat: telegram.message_format === "rich" ? "rich" : "html",
    },
    webui: projectWebuiSettings(document),
    metrics: projectMetricsSettings(document),
    workspaces: projectWorkspaceSettings(document),
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
  } = {},
) {
  const { configPath } = requireUserConfig(environment);
  assertExpectedRevision(expectedRevision);
  const snapshot = readConfigSnapshot(configPath, readConfig);
  if (snapshot.revision !== expectedRevision) {
    throw invalid("revision", "stale-revision", "Gateway 配置已变化，请重新读取设置");
  }
  const document = snapshot.document;
  const result = applySetting(document, input);
  if (readConfig(configPath, "utf8") !== snapshot.content) {
    throw invalid("revision", "stale-revision", "Gateway 配置已变化，请重新读取设置");
  }
  const backupPath = result.backupRequired
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
    ...(backupPath === null ? {} : { backupPath }),
  };
}

export function validateNetworkProxyValue(field, value) {
  if (!proxyFields.includes(field)) return `未知网络代理字段：${String(field)}`;
  const normalized = stringValue(value);
  if (!normalized) return undefined;
  return field === "no_proxy" ? validateNoProxy(normalized) : validateProxyUrl(normalized);
}

function applySetting(document, input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw invalid("input", "invalid-input", "设置输入必须是对象");
  }
  const delegated = applyWebuiSetting(document, input)
    ?? applyMetricsSetting(document, input)
    ?? applyWorkspaceSetting(document, input);
  if (delegated !== undefined) return delegated;
  switch (input.kind) {
    case "display.operation-updates": {
      const value = enumValue(input.value, operationUpdateValues, "value", "操作详情显示");
      document.display = { ...table(document.display), operation_updates: value };
      return changed(value, "restart-gateway");
    }
    case "display.plan-updates": {
      const value = booleanValue(input.value, "value", "计划更新显示");
      document.display = { ...table(document.display), plan_updates: value };
      return changed(value, "restart-gateway");
    }
    case "display.reasoning": {
      const value = booleanValue(input.value, "value", "思考状态显示");
      document.display = { ...table(document.display), reasoning: value };
      return changed(value, "restart-gateway");
    }
    case "display.price-currency": {
      const value = enumValue(input.value, priceCurrencyValues, "value", "价格显示方式");
      const display = { ...table(document.display), price_currency: value };
      delete display.price_currency_by_provider;
      document.display = display;
      return changed(value, "restart-gateway");
    }
    case "telegram.message-format": {
      const value = enumValue(input.value, messageFormatValues, "value", "Telegram 消息格式");
      document.telegram = { ...table(document.telegram), message_format: value };
      return changed(value, "restart-gateway");
    }
    case "system.approval-timeout": {
      const value = integerValue(input.value, 30, 3_600, "value", "审批超时");
      document.approval = { ...table(document.approval), timeout_seconds: value };
      return changed(value, "restart-gateway");
    }
    case "system.sandbox": {
      const value = enumValue(input.value, sandboxValues, "value", "Gateway 渠道 Sandbox");
      document.codex = { ...table(document.codex), sandbox: value };
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
    case "automation.scheduled-tasks": {
      const value = booleanValue(input.value, "value", "计划任务");
      document.scheduled_tasks = { ...table(document.scheduled_tasks), enabled: value };
      return changed(value, "restart-gateway");
    }
    case "automation.thread-section-administrators": {
      const candidates = threadSectionAdministratorCandidates(document);
      const value = uniqueStrings(input.value, "value", "Thread 分区管理员");
      if (value.some((actor) => !candidates.some((candidate) => candidate.value === actor))) {
        throw invalid("value", "unknown-actor", "Thread 分区管理员选择无效");
      }
      document.thread_sections = { administrators: value };
      return changed(value, "restart-gateway");
    }
    case "advanced.logging-level": {
      const value = enumValue(input.value, loggingLevelValues, "value", "日志等级");
      document.logging = { ...table(document.logging), level: value };
      return changed(value, "restart-gateway");
    }
    case "advanced.plugin-api": {
      const value = booleanValue(input.value, "value", "Plugin API");
      document.experimental = { ...table(document.experimental), plugin_api: value };
      return changed(value, "restart-gateway");
    }
    case "network.proxy":
      return applyNetworkProxy(document, input);
    case "network.proxy-batch":
      return applyNetworkProxyBatch(document, input);
    default:
      throw invalid("kind", "unknown-setting", `未知 Gateway 设置：${String(input.kind)}`);
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

function readConfigSnapshot(configPath, readConfig = readFileSync) {
  const content = readConfig(configPath, "utf8");
  return {
    content,
    document: parseGatewayConfig(content, configPath),
    revision: createHash("sha256").update(content).digest("hex"),
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

function threadSectionAdministratorCandidates(document) {
  return [
    ...(stringValue(table(document.telegram).bot_token)
      ? numberArray(table(document.telegram).allowed_user_ids).map((actorId) => ({
          value: `telegram:${actorId}`,
          surface: "telegram",
          actorId: String(actorId),
          displayName: `Telegram · ${actorId}`,
        }))
      : []),
    ...(table(document.feishu).enabled === true
      ? stringArray(table(document.feishu).allowed_open_ids).map((actorId) => ({
          value: `feishu:${actorId}`,
          surface: "feishu",
          actorId,
          displayName: `飞书 · ${actorId}`,
        }))
      : []),
    ...(table(document.weixin).enabled === true
      ? stringArray(table(document.weixin).allowed_user_ids).map((actorId) => ({
          value: `weixin:${actorId}`,
          surface: "weixin",
          actorId,
          displayName: `微信 · ${actorId}`,
        }))
      : []),
  ];
}

function validateProxyUrl(value) {
  if (value.length > 2_048 || /[\0\r\n]/u.test(value)) return "代理 URL 无效或过长";
  try {
    resolveHttpProxyUrl(value, {});
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : "代理 URL 无效";
  }
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

function uniqueStrings(value, field, label) {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw invalid(field, "invalid-list", `${label}必须是字符串数组`);
  }
  return [...new Set(value.map((entry) => entry.trim()).filter(Boolean))];
}

function invalid(field, code, message) {
  return invalidSetting(field, code, message);
}

function integerInRange(value, minimum, maximum) {
  return Number.isInteger(value) && value >= minimum && value <= maximum ? value : undefined;
}

function numberArray(value) {
  return Array.isArray(value) ? value.filter((entry) => Number.isInteger(entry) && entry > 0) : [];
}

function stringArray(value) {
  return Array.isArray(value) ? value.filter((entry) => stringValue(entry)).map(stringValue) : [];
}

function stringValue(value) {
  return typeof value === "string" ? value.trim() : "";
}

function table(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
