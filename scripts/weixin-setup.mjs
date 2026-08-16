import { join } from "node:path";
import { pathToFileURL } from "node:url";

import qrcode from "qrcode";

import {
  readGatewayConfig,
  writeGatewayConfig,
} from "../runtime/gateway-config.mjs";
import { writeGatewayConfigActivationNotice } from "./config-activation-notice.mjs";
import {
  FIXED_WEIXIN_QR_BASE_URL,
  createWeixinQrContractClient,
  runWeixinQrLoginContract,
} from "./weixin-qr-contract-probe.mjs";
import { requireUserConfig } from "./runtime-config.mjs";
import { createPrompter } from "./terminal-prompter.mjs";

export async function runWeixinSetup({
  environment = process.env,
  input = process.stdin,
  output = process.stdout,
  prompter,
  client = createWeixinQrContractClient(),
  runLogin = runWeixinQrLoginContract,
  renderQRCode = renderTerminalQRCode,
  createCredentialStore = loadCredentialStore,
  validateCredential = validatedCredential,
  writeConfig = writeGatewayConfig,
  now = Date.now,
} = {}) {
  const { configPath, dataDir } = requireUserConfig(environment);
  const document = readGatewayConfig(configPath);
  const existing = table(document.weixin);
  const prompt = prompter ?? createPrompter(input, output);

  try {
    output.write("\nCodex Connect 微信 Setup\n\n");
    output.write("扫码成功后默认安全保存为未启用；确认配置后可启用微信消息接收。\n");
    output.write("警告：微信可能用新连接替换并删除该账号已有的机器人连接。\n");
    if (!await prompt.confirm("确认继续扫码连接微信？", false)) {
      output.write("已取消，未请求微信二维码。\n");
      return undefined;
    }

    const result = await runLogin({
      client,
      baseUrl: FIXED_WEIXIN_QR_BASE_URL,
      displayQr: async (value) => {
        output.write("\n请使用微信扫描下面的二维码：\n\n");
        renderQRCode(value, output);
      },
      readVerifyCode: () => prompt.ask("请输入手机微信显示的数字"),
      onStatus: (status) => renderStatus(status, output),
    });
    if (result.kind !== "confirmed") {
      output.write("微信返回已连接状态；未签发新凭据，配置未修改。\n");
      return undefined;
    }
    const credential = await validateCredential(result, now());
    const scannerId = validateActorId(result.userId);
    const existingAllowed = existing.account_id === credential.accountId
      ? validActorIds(existing.allowed_user_ids)
      : [];
    const allowedUserIds = existingAllowed.length > 0
      && await prompt.confirm("保留当前微信允许名单并加入本次扫码用户？", true)
      ? unique([scannerId, ...existingAllowed])
      : [scannerId];

    output.write("\n准备保存微信连接：\n");
    output.write(`- 账号 ID：${credential.accountId}\n`);
    output.write(`- 扫码用户：${scannerId}\n`);
    output.write("- Bot Token：已获取（不显示）\n");
    output.write("- 运行状态：已配置，默认未启用\n");
    if (!await prompt.confirm("确认安全保存以上连接？", true)) {
      output.write("未保存微信连接；本次 Token 已丢弃。\n");
      return undefined;
    }

    const store = await createCredentialStore(
      join(dataDir, "credentials", "weixin"),
    );
    const previous = await store.get(credential.accountId);
    await store.set(credential);
    try {
      document.weixin = {
        enabled: false,
        account_id: credential.accountId,
        allowed_user_ids: allowedUserIds,
      };
      writeConfig(configPath, document);
    } catch (error) {
      if (previous) {
        await store.set(previous);
      } else {
        await store.remove(credential.accountId);
      }
      throw error;
    }
    const oldAccountId = stringValue(existing.account_id);
    if (oldAccountId && oldAccountId !== credential.accountId) {
      try {
        await store.remove(oldAccountId);
      } catch {
        output.write("微信新连接已保存，但旧账号本地凭据清理失败；请运行 codexc doctor 检查。\n");
      }
    }

    output.write(`\n微信连接已安全保存：${configPath}\n`);
    writeGatewayConfigActivationNotice(output);
    output.write(
      "如需启用消息接收，请将 weixin.enabled 改为 true，然后运行 codexc service reload。\n",
    );
    return {
      accountId: credential.accountId,
      allowedUserIds,
      configPath,
    };
  } finally {
    prompt.close();
  }
}

async function validatedCredential(result, grantedAt) {
  const module = await import("../dist/surfaces/weixin/index.js");
  return {
    version: 1,
    accountId: module.validateWeixinAccountId(result.accountId),
    botToken: requiredString(result.botToken, "微信 Bot Token 无效"),
    baseUrl: module.validateWeixinBaseUrl(result.baseUrl),
    grantedAt,
  };
}

async function loadCredentialStore(directory) {
  const module = await import("../dist/surfaces/weixin/index.js");
  return module.createWeixinCredentialStore(directory);
}

function validateActorId(value) {
  if (
    typeof value !== "string"
    || !/^[^\s@]{1,1000}@im\.wechat$/u.test(value)
  ) {
    throw new Error("微信扫码用户 ID 无效");
  }
  return value;
}

function requiredString(value, message) {
  if (typeof value !== "string" || !value || value.length > 16_384) {
    throw new Error(message);
  }
  return value;
}

function renderStatus(status, output) {
  const messages = {
    scaned: "二维码已扫描，等待确认。\n",
    expired: "二维码已过期，正在刷新。\n",
    scaned_but_redirect: "微信要求切换状态轮询节点。\n",
    need_verifycode: "微信要求输入配对码。\n",
  };
  if (messages[status]) {
    output.write(messages[status]);
  }
}

function renderTerminalQRCode(value, output) {
  qrcode.toString(value, { type: "terminal", small: true }, (error, rendered) => {
    if (error) {
      output.write(`二维码渲染失败：${error.message}\n`);
      return;
    }
    output.write(`${rendered}\n`);
  });
}

function validActorIds(value) {
  return Array.isArray(value)
    ? value.filter((item) =>
        typeof item === "string"
        && /^[^\s@]{1,1000}@im\.wechat$/u.test(item))
    : [];
}

function unique(values) {
  return [...new Set(values)];
}

function table(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function stringValue(value) {
  return typeof value === "string" ? value.trim() : "";
}

function isDirectExecution(moduleUrl, argvPath) {
  return Boolean(argvPath) && moduleUrl === pathToFileURL(argvPath).href;
}

if (isDirectExecution(import.meta.url, process.argv[1])) {
  await runWeixinSetup().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
