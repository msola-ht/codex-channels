import { invalidSetting } from "./config-management-error.mjs";

const hosts = ["127.0.0.1", "::1", "0.0.0.0"];

export function projectWebuiSettings(document) {
  const webui = table(document.webui);
  return {
    host: hosts.includes(webui.host) ? webui.host : "127.0.0.1",
    port: integerInRange(webui.port, 1, 65_535) ?? 8_787,
    tokenConfigured: nonEmptyString(webui.token),
  };
}

export function applyWebuiSetting(document, input) {
  const webui = { ...table(document.webui) };
  switch (input.kind) {
    case "webui.host": {
      const value = nullableChoice(input.value, hosts, "value", "WebUI 监听地址");
      if (value === "0.0.0.0" && !nonEmptyString(webui.token)) {
        webui.token = requiredSecret(input.token, "token", "WebUI 访问令牌");
      }
      if (value === null) delete webui.host;
      else webui.host = value;
      break;
    }
    case "webui.port": {
      const value = nullableInteger(input.value, 1, 65_535, "value", "WebUI 监听端口");
      if (value === null) delete webui.port;
      else webui.port = value;
      break;
    }
    case "webui.token": {
      const action = choice(input.action, ["set", "clear"], "action", "WebUI 令牌操作");
      if (action === "clear") {
        if (webui.host === "0.0.0.0") {
          throw invalidSetting("action", "public-token-required", "WebUI 绑定 0.0.0.0 时必须保留访问令牌");
        }
        delete webui.token;
      } else {
        webui.token = requiredSecret(input.value, "value", "WebUI 访问令牌");
      }
      break;
    }
    default:
      return undefined;
  }
  document.webui = webui;
  return {
    value: projectWebuiSettings(document),
    activation: "restart-webui",
  };
}

function requiredSecret(value, field, label) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) throw invalidSetting(field, "required", `${label}不能为空`);
  if (normalized.length > 4_096 || /[\0\r\n]/u.test(normalized)) {
    throw invalidSetting(field, "invalid-secret", `${label}无效或过长`);
  }
  return normalized;
}

function nullableChoice(value, allowed, field, label) {
  if (value === null) return null;
  return choice(value, allowed, field, label);
}

function choice(value, allowed, field, label) {
  if (!allowed.includes(value)) {
    throw invalidSetting(field, "invalid-choice", `${label}无效：${String(value)}`);
  }
  return value;
}

function nullableInteger(value, minimum, maximum, field, label) {
  if (value === null) return null;
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw invalidSetting(field, "invalid-integer", `${label}必须为 ${minimum}–${maximum} 之间的整数`);
  }
  return value;
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
