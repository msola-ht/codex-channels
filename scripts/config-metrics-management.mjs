import { randomBytes } from "node:crypto";
import { isPrivateHttpEndpoint } from "../runtime/gateway-config.mjs";
import { invalidSetting } from "./config-management-error.mjs";

const hosts = ["127.0.0.1", "::1", "0.0.0.0"];
const deviceIdPattern = /^[a-z0-9][a-z0-9_-]{0,63}$/u;

export function projectMetricsSettings(document) {
  const metrics = table(document.metrics);
  const storage = table(metrics.storage);
  const sync = table(metrics.sync);
  const view = table(metrics.view);
  const center = table(metrics.center);
  return {
    storage: {
      retentionDays: integerInRange(storage.retention_days, 1, 3_650) ?? 365,
      maxRows: integerInRange(storage.max_rows, 1_000, 10_000_000) ?? 1_000_000,
    },
    sync: {
      enabled: sync.enabled === true,
      endpoint: optionalString(sync.endpoint),
      deviceId: optionalString(sync.device_id),
      deviceName: optionalString(sync.device_name),
      deviceTokenConfigured: nonEmptyString(sync.device_token),
      intervalSeconds: integerInRange(sync.interval_seconds, 10, 86_400) ?? 60,
      batchSize: integerInRange(sync.batch_size, 1, 500) ?? 200,
    },
    view: {
      enabled: view.enabled === true,
      endpoint: optionalString(view.endpoint),
      tokenConfigured: nonEmptyString(view.token),
    },
    center: {
      enabled: center.enabled === true,
      host: hosts.includes(center.host) ? center.host : "127.0.0.1",
      port: integerInRange(center.port, 1, 65_535) ?? 8_790,
      tokenConfigured: nonEmptyString(center.token),
      deviceTokenConfigured: nonEmptyString(center.device_token),
      databasePath: optionalString(center.database_path) ?? "data/central-metrics.sqlite3",
    },
  };
}

export function applyMetricsSetting(document, input) {
  if (!String(input.kind).startsWith("metrics.")) return undefined;
  const metrics = { ...table(document.metrics) };
  let generatedTokens;
  switch (input.kind) {
    case "metrics.storage":
      metrics.storage = {
        retention_days: integer(input.retentionDays, 1, 3_650, "retentionDays", "指标保留天数"),
        max_rows: integer(input.maxRows, 1_000, 10_000_000, "maxRows", "指标最大行数"),
      };
      break;
    case "metrics.sync-params": {
      const sync = { ...table(metrics.sync) };
      if (input.intervalSeconds === undefined && input.batchSize === undefined) {
        throw invalidSetting("input", "required", "至少提供一个指标上报参数");
      }
      if (input.intervalSeconds !== undefined) {
        sync.interval_seconds = integer(input.intervalSeconds, 10, 86_400, "intervalSeconds", "上报间隔");
      }
      if (input.batchSize !== undefined) {
        sync.batch_size = integer(input.batchSize, 1, 500, "batchSize", "单批上限");
      }
      metrics.sync = sync;
      break;
    }
    case "metrics.connect": {
      const endpoint = normalizeEndpoint(input.endpoint, "endpoint");
      const deviceToken = secret(input.deviceToken, "deviceToken", "设备上报令牌");
      const viewToken = secret(input.viewToken, "viewToken", "全局查看令牌");
      if (deviceToken === viewToken) {
        throw invalidSetting("viewToken", "token-conflict", "设备上报令牌与全局查看令牌必须不同");
      }
      const deviceId = optionalString(input.deviceId);
      if (deviceId !== null && !deviceIdPattern.test(deviceId)) {
        throw invalidSetting("deviceId", "invalid-device-id", "设备 ID 格式无效");
      }
      const sync = { ...table(metrics.sync),
        enabled: true,
        endpoint: `${endpoint}/api/ingest`,
        device_token: deviceToken,
      };
      if (deviceId !== null) sync.device_id = deviceId;
      else delete sync.device_id;
      const deviceName = optionalString(input.deviceName);
      if (deviceName !== null) sync.device_name = deviceName;
      else delete sync.device_name;
      metrics.sync = sync;
      metrics.view = { enabled: true, endpoint, token: viewToken };
      break;
    }
    case "metrics.disconnect": {
      metrics.sync = { ...table(metrics.sync), enabled: false };
      if (metrics.view !== undefined) metrics.view = { ...table(metrics.view), enabled: false };
      break;
    }
    case "metrics.center.host": {
      const center = { ...table(metrics.center) };
      const value = nullableChoice(input.value, hosts, "value", "中心监听地址");
      if (value === "0.0.0.0") {
        if (!nonEmptyString(center.token)) center.token = secret(input.token, "token", "中心查看令牌");
        if (!nonEmptyString(center.device_token)) {
          center.device_token = secret(input.deviceToken, "deviceToken", "中心设备上报令牌");
        }
      }
      if (value === null) delete center.host;
      else center.host = value;
      assertDistinctCenterTokens(center);
      metrics.center = center;
      break;
    }
    case "metrics.center.port": {
      const center = { ...table(metrics.center) };
      if (input.value === null) delete center.port;
      else center.port = integer(input.value, 1, 65_535, "value", "中心监听端口");
      metrics.center = center;
      break;
    }
    case "metrics.center.token": {
      const center = { ...table(metrics.center) };
      const field = choice(input.field, ["token", "device_token"], "field", "中心令牌字段");
      const action = choice(input.action, ["set", "clear"], "action", "中心令牌操作");
      if (action === "clear") {
        if (center.host === "0.0.0.0") {
          throw invalidSetting("action", "public-token-required", "中心绑定 0.0.0.0 时必须保留两个访问令牌");
        }
        delete center[field];
      } else {
        center[field] = secret(input.value, "value", field === "token" ? "中心查看令牌" : "中心设备上报令牌");
      }
      assertDistinctCenterTokens(center);
      metrics.center = center;
      break;
    }
    case "metrics.center.generate-tokens": {
      const center = { ...table(metrics.center) };
      center.token = randomBytes(32).toString("hex");
      center.device_token = randomBytes(32).toString("hex");
      generatedTokens = { viewToken: center.token, deviceToken: center.device_token };
      metrics.center = center;
      break;
    }
    case "metrics.center.database-path": {
      const center = { ...table(metrics.center) };
      const value = optionalString(input.value);
      if (value === null) delete center.database_path;
      else if (value.length > 4_096 || /[\0\r\n]/u.test(value)) {
        throw invalidSetting("value", "invalid-path", "中心数据库路径无效或过长");
      } else center.database_path = value;
      metrics.center = center;
      break;
    }
    default:
      throw invalidSetting("kind", "unknown-setting", `未知数据中心设置：${String(input.kind)}`);
  }
  document.metrics = metrics;
  const activation = input.kind === "metrics.connect" || input.kind === "metrics.disconnect"
    ? "restart-gateway-webui"
    : input.kind.startsWith("metrics.center.")
      ? "restart-center"
      : "restart-gateway";
  return {
    value: projectMetricsSettings(document),
    activation,
    backupRequired: input.kind === "metrics.connect" || input.kind === "metrics.disconnect",
    ...(generatedTokens === undefined ? {} : { generatedTokens }),
  };
}

function normalizeEndpoint(value, field) {
  const normalized = requiredString(value, field, "中心地址");
  let url;
  try {
    url = new URL(normalized);
  } catch {
    throw invalidSetting(field, "invalid-url", `中心地址无效：${normalized}`);
  }
  if (url.protocol !== "https:" && !isPrivateHttpEndpoint(url)) {
    throw invalidSetting(field, "insecure-url", "中心地址必须使用 HTTPS，或指向回环/私网地址的 HTTP");
  }
  return url.toString().replace(/\/+$/u, "");
}

function assertDistinctCenterTokens(center) {
  if (nonEmptyString(center.token) && center.token === center.device_token) {
    throw invalidSetting("value", "token-conflict", "中心查看令牌与设备上报令牌必须不同");
  }
}

function secret(value, field, label) {
  const normalized = requiredString(value, field, label);
  if (normalized.length > 4_096 || /[\0\r\n]/u.test(normalized)) {
    throw invalidSetting(field, "invalid-secret", `${label}无效或过长`);
  }
  return normalized;
}

function integer(value, minimum, maximum, field, label) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw invalidSetting(field, "invalid-integer", `${label}必须为 ${minimum}–${maximum} 之间的整数`);
  }
  return value;
}

function nullableChoice(value, allowed, field, label) {
  if (value === null) return null;
  return choice(value, allowed, field, label);
}

function choice(value, allowed, field, label) {
  if (!allowed.includes(value)) throw invalidSetting(field, "invalid-choice", `${label}无效：${String(value)}`);
  return value;
}

function requiredString(value, field, label) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) throw invalidSetting(field, "required", `${label}不能为空`);
  return normalized;
}

function optionalString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function integerInRange(value, minimum, maximum) {
  return Number.isInteger(value) && value >= minimum && value <= maximum ? value : undefined;
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function table(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
