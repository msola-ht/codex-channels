import { Client, LoggerLevel } from "@larksuiteoapi/node-sdk";

const appIdPattern = /^cli_[0-9a-fA-F]{16}$/u;
const openIdPattern = /^ou_.+$/u;
const defaultRequestTimeoutMs = 10_000;

export async function validateFeishuApplication(
  { appId, appSecret },
  {
    createClient = createFeishuClient,
    requestTimeoutMs = defaultRequestTimeoutMs,
  } = {},
) {
  if (
    !appIdPattern.test(stringValue(appId))
    || stringValue(appSecret).length === 0
  ) {
    throw new Error("飞书应用凭据格式无效");
  }

  try {
    const client = createClient({
      appId,
      appSecret,
      logger: silentSdkLogger,
      loggerLevel: LoggerLevel.error,
      source: "codexc",
    });
    const response = await client.request({
      method: "GET",
      url: "/open-apis/bot/v3/info",
      timeout: requestTimeoutMs,
    });
    const openId = stringValue(response?.bot?.open_id);
    if (!openIdPattern.test(openId)) {
      throw new Error("invalid bot identity");
    }
    return {
      openId,
      name: stringValue(response?.bot?.app_name) || "已验证",
    };
  } catch {
    throw new Error("飞书应用凭据或机器人身份验证失败");
  }
}

const silentSdkLogger = {
  error: () => {},
  warn: () => {},
  info: () => {},
  debug: () => {},
  trace: () => {},
};

function createFeishuClient(options) {
  return new Client(options);
}

function stringValue(value) {
  return typeof value === "string" ? value.trim() : "";
}
