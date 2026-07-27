import { pathToFileURL } from "node:url";

import { registerApp } from "@larksuiteoapi/node-sdk";
import qrcode from "qrcode-terminal";

import {
  readGatewayConfig,
  writeGatewayConfig,
} from "../runtime/gateway-config.mjs";
import { validateFeishuApplication } from "./feishu-application.mjs";
import { requireUserConfig } from "./runtime-config.mjs";
import { createPrompter } from "./terminal-prompter.mjs";

const appIdPattern = /^cli_[0-9a-fA-F]{16}$/u;
const openIdPattern = /^ou_.+$/u;
const defaultTimeoutSeconds = 600;

export async function runFeishuSetup({
  environment = process.env,
  input = process.stdin,
  output = process.stdout,
  prompter,
  registerApplication = registerApp,
  validateApplication = validateFeishuApplication,
  configureApplication = configureFeishuApplication,
  renderQRCode = renderTerminalQRCode,
  createSignal = createTimeoutSignal,
  timeoutSeconds = defaultTimeoutSeconds,
} = {}) {
  const { configPath } = requireUserConfig(environment);
  const document = readGatewayConfig(configPath);
  const existing = table(document.feishu);
  const prompt = prompter ?? createPrompter(input, output);

  try {
    output.write("\nCodex Connect 飞书 Setup\n\n");
    output.write("1. 手动输入应用凭据\n");
    output.write("2. 扫码授权\n");
    const choice = await askChoice(prompt, "请选择 [1-2]", 2);
    const scanRegistration = choice === "2";

    let result;
    if (choice === "1") {
      result = await readManualRegistration(prompt, output);
    } else {
      output.write("\n扫码后请在飞书授权页选择新建应用或已有应用。\n");
      output.write("扫码只用于本次注册；短期授权信息不会保存。\n");
      let registration;
      try {
        registration = await registerApplication({
          source: "codexc",
          signal: createSignal(timeoutSeconds),
          addons: {
            preset: false,
            scopes: {
              tenant: [
                "application:application:self_manage",
                "application:application:patch",
                "im:message:send_as_bot",
                "cardkit:card:write",
              ],
            },
            events: {
              items: {
                tenant: [
                  "im.message.receive_v1",
                  "application.bot.menu_v6",
                ],
              },
            },
            callbacks: {
              items: ["card.action.trigger"],
            },
          },
          onQRCodeReady: ({ url, expireIn }) => {
            const authorizationUrl = validateAuthorizationUrl(url);
            output.write("\n请使用飞书扫描下面的二维码，并在确认页完成授权：\n\n");
            renderQRCode(authorizationUrl, output);
            output.write(`\n二维码有效期约 ${positiveInteger(expireIn, timeoutSeconds)} 秒。\n`);
            output.write(`无法扫码时可在浏览器打开：${authorizationUrl}\n\n`);
          },
        });
      } catch (error) {
        throw registrationError(error);
      }
      result = validateRegistration(registration);
    }

    const bot = await validateRegisteredApplication(
      validateApplication,
      result,
    );
    const existingAllowedOpenIds = validConfiguredOpenIds(
      existing.allowed_open_ids,
    );
    let allowedOpenIds = result.openId ? [result.openId] : [];
    if (
      existingAllowedOpenIds.length > 0
      && await prompt.confirm(
        result.openId
          ? "保留当前允许名单并加入扫码用户？"
          : "保留当前允许名单？",
        true,
      )
    ) {
      allowedOpenIds = normalizeOpenIds([
        ...allowedOpenIds,
        ...existingAllowedOpenIds,
      ]);
    }
    allowedOpenIds = await collectAllowedOpenIds(
      prompt,
      output,
      allowedOpenIds,
    );

    output.write("\n准备保存飞书配置：\n");
    output.write("- 状态：启用\n");
    output.write(`- App ID：${result.appId}\n`);
    output.write(`- Bot：${bot.name}\n`);
    output.write("- App Secret：已获取（不显示）\n");
    output.write(`- 允许用户：${allowedOpenIds.join(", ")}\n`);
    if (!await prompt.confirm("确认保存以上配置？", true)) {
      output.write("未保存飞书配置。\n");
      return undefined;
    }

    document.feishu = {
      ...existing,
      enabled: true,
      app_id: result.appId,
      app_secret: result.appSecret,
      allowed_open_ids: allowedOpenIds,
    };
    writeGatewayConfig(configPath, document);
    output.write(`\n飞书配置已保存：${configPath}\n`);
    if (scanRegistration) {
      output.write("正在自动配置并发布飞书机器人悬浮菜单…\n");
      try {
        const configured = await configureApplication({
          appId: result.appId,
          appSecret: result.appSecret,
        });
        output.write(
          configured?.changed
            ? "飞书机器人悬浮菜单已自动配置并发布。\n"
            : "飞书机器人悬浮菜单已经配置完成。\n",
        );
      } catch {
        output.write(
          "飞书连接配置已保存，但机器人菜单自动配置未完成；"
          + "Gateway 启动后可发送 /feishu doctor 恢复。\n",
        );
      }
    }
    output.write("下一步运行：codexc doctor\n");
    if (!scanRegistration) {
      output.write(
        "Gateway 启动后，在飞书私聊发送 /feishu doctor "
        + "完成机器人菜单和订阅配置。\n",
      );
    }
    output.write("运行中的 Gateway 会检测配置变化并重启飞书 Surface。\n");
    return {
      appId: result.appId,
      allowedOpenIds,
      configPath,
    };
  } finally {
    prompt.close();
  }
}

export function normalizeOpenIds(values) {
  const openIds = [];
  for (const raw of values) {
    const value = String(raw).trim();
    if (!value) {
      continue;
    }
    if (!openIdPattern.test(value)) {
      throw new Error(`无效的飞书用户 Open ID：${value}`);
    }
    if (!openIds.includes(value)) {
      openIds.push(value);
    }
  }
  if (openIds.length === 0) {
    throw new Error("至少需要一个飞书用户 Open ID");
  }
  return openIds;
}

function validateRegistration(value) {
  if (!value || typeof value !== "object") {
    throw new Error("飞书扫码注册返回无效");
  }
  const appId = stringValue(value.client_id);
  const appSecret = stringValue(value.client_secret);
  const openId = stringValue(value.user_info?.open_id);
  if (!appIdPattern.test(appId) || !appSecret || !openIdPattern.test(openId)) {
    throw new Error("飞书扫码注册返回缺少有效的应用凭据或用户 Open ID");
  }
  if (value.user_info?.tenant_brand === "lark") {
    throw new Error("当前项目暂不支持 Lark 租户");
  }
  return { appId, appSecret, openId };
}

async function readManualRegistration(prompt, output) {
  output.write("App ID、App Secret 的输入内容会显示，请避开屏幕共享或录屏。\n");
  let appId;
  while (!appId) {
    const value = await prompt.ask("飞书 App ID");
    if (appIdPattern.test(value)) {
      appId = value;
    } else {
      output.write("App ID 格式无效，应为 cli_ 加 16 位十六进制字符。\n");
    }
  }
  let appSecret;
  while (!appSecret) {
    appSecret = (await prompt.secret("飞书 App Secret")).trim();
    if (!appSecret) {
      output.write("App Secret 不能为空。\n");
    }
  }
  return { appId, appSecret };
}

async function collectAllowedOpenIds(prompt, output, initial) {
  while (true) {
    const entered = await prompt.ask(
      initial.length === 0
        ? "允许的用户 Open ID（多个用逗号分隔）"
        : "其他允许的用户 Open ID（可选，多个用逗号分隔）",
    );
    try {
      return normalizeOpenIds([
        ...initial,
        ...entered.split(","),
      ]);
    } catch (error) {
      output.write(`${error instanceof Error ? error.message : String(error)}\n`);
    }
  }
}

async function validateRegisteredApplication(validateApplication, result) {
  try {
    const bot = await validateApplication({
      appId: result.appId,
      appSecret: result.appSecret,
    });
    const openId = stringValue(bot?.openId);
    if (!openIdPattern.test(openId)) {
      throw new Error("invalid bot identity");
    }
    return {
      openId,
      name: stringValue(bot?.name) || "已验证",
    };
  } catch {
    throw new Error("飞书应用凭据或机器人身份验证失败");
  }
}

function validateAuthorizationUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("飞书扫码授权地址无效");
  }
  if (
    parsed.protocol !== "https:"
    || !isTrustedFeishuHostname(parsed.hostname)
  ) {
    throw new Error("飞书扫码授权地址来源无效");
  }
  return parsed.toString();
}

function isTrustedFeishuHostname(hostname) {
  return [
    "feishu.cn",
    "larksuite.com",
  ].some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
}

function registrationError(error) {
  const code = errorCode(error);
  switch (code) {
    case "access_denied":
      return new Error("飞书扫码授权已被拒绝");
    case "expired_token":
      return new Error("飞书扫码授权已过期，请重新运行 Setup");
    case "abort":
      return new Error("飞书扫码授权已取消或超时");
    default:
      return error instanceof Error
        && (
          error.message === "飞书扫码授权地址无效"
          || error.message === "飞书扫码授权地址来源无效"
        )
        ? error
        : new Error("飞书扫码注册失败");
  }
}

function renderTerminalQRCode(url, output) {
  qrcode.generate(url, { small: true }, (rendered) => {
    output.write(`${rendered}\n`);
  });
}

function createTimeoutSignal(timeoutSeconds) {
  return globalThis.AbortSignal.timeout(timeoutSeconds * 1_000);
}

function validConfiguredOpenIds(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  try {
    return normalizeOpenIds(value);
  } catch {
    return [];
  }
}

async function askChoice(prompt, label, maximum) {
  while (true) {
    const choice = await prompt.ask(label);
    if (new RegExp(`^[1-${maximum}]$`).test(choice)) {
      return choice;
    }
  }
}

function positiveInteger(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function errorCode(error) {
  return error && typeof error === "object" && typeof error.code === "string"
    ? error.code
    : "";
}

function table(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function stringValue(value) {
  return typeof value === "string" ? value.trim() : "";
}

async function configureFeishuApplication({ appId, appSecret }) {
  const { FeishuApplicationHttpApi } = await import(
    "../dist/surfaces/feishu/index.js"
  );
  return new FeishuApplicationHttpApi({
    appId,
    appSecret,
  }).configureApplication();
}

function isDirectExecution(moduleUrl, argvPath) {
  return Boolean(argvPath) && moduleUrl === pathToFileURL(argvPath).href;
}

if (isDirectExecution(import.meta.url, process.argv[1])) {
  await runFeishuSetup().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
