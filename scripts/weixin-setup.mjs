import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

import qrcode from "qrcode";

import { writeGatewayConfigActivationNotice } from "./config-activation-notice.mjs";
import {
  createWeixinQrContractClient,
  runWeixinQrLoginContract,
} from "./weixin-qr-contract-probe.mjs";
import {
  WeixinSetupSessionError,
  createWeixinSetupSession,
} from "./weixin-setup-session.mjs";
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
  writeConfig,
  now = Date.now,
  createSetupSession = createWeixinSetupSession,
} = {}) {
  const prompt = prompter ?? createPrompter(input, output);
  const ownerId = `codexc-setup:${randomUUID()}`;
  let session;
  let unsubscribe;
  let verificationTask;
  let lastVerificationRequestId;
  let adapterError;
  let promptAbortController;

  const promptWithinSession = async (operation) => {
    const before = session.status(ownerId);
    if (isTerminatedSetupStatus(before)) throw weixinSetupFailure(before);
    const controller = new AbortController();
    promptAbortController = controller;
    try {
      const value = await operation(controller.signal);
      const after = session.status(ownerId);
      if (isTerminatedSetupStatus(after)) throw weixinSetupFailure(after);
      return value;
    } catch (error) {
      const current = session.status(ownerId);
      if (isTerminatedSetupStatus(current)) {
        throw weixinSetupFailure(current);
      }
      throw error;
    } finally {
      if (promptAbortController === controller) {
        promptAbortController = undefined;
      }
    }
  };

  try {
    output.write("\nCodex Connect 微信 Setup\n\n");
    output.write("扫码成功后默认安全保存为未启用；确认配置后可启用微信消息接收。\n");
    output.write("警告：微信可能用新连接替换并删除该账号已有的机器人连接。\n");
    if (!await prompt.confirm("确认继续扫码连接微信？", false)) {
      output.write("已取消，未请求微信二维码。\n");
      return undefined;
    }

    session = createSetupSession({ ownerId }, {
      environment,
      client,
      runLogin,
      createCredentialStore,
      validateCredential,
      ...(writeConfig === undefined ? {} : { writeConfig }),
      now,
    });
    let lastQrCode;
    let lastUpstreamStatus;
    unsubscribe = session.subscribe(ownerId, (status) => {
      if (status.qrCode && status.qrCode !== lastQrCode) {
        lastQrCode = status.qrCode;
        output.write("\n请使用微信扫描下面的二维码：\n\n");
        renderQRCode(status.qrCode, output);
      }
      if (
        status.upstreamStatus
        && status.upstreamStatus !== lastUpstreamStatus
      ) {
        lastUpstreamStatus = status.upstreamStatus;
        renderStatus(status.upstreamStatus, output);
      }
      if (
        status.state === "verification-required"
        && status.verificationRequestId !== lastVerificationRequestId
      ) {
        lastVerificationRequestId = status.verificationRequestId;
        verificationTask = promptWithinSession((signal) =>
          prompt.ask("请输入手机微信显示的数字", { signal }))
          .then((code) => session.provideVerificationCode(ownerId, code))
          .catch((error) => {
            adapterError = error;
            session.cancel(ownerId);
          });
      }
      if (isTerminatedSetupStatus(status)) {
        promptAbortController?.abort();
      }
    });
    session.start(ownerId);
    const status = await session.waitForLogin(ownerId);
    await verificationTask;
    if (adapterError) throw adapterError;
    if (status.state === "already-connected") {
      output.write("微信返回已连接状态；未签发新凭据，配置未修改。\n");
      return undefined;
    }
    if (status.state !== "ready" || !status.preview) {
      throw weixinSetupFailure(status);
    }
    const preserveExistingAllowedUsers = status.preview.existingAllowedUserCount > 0
      && await promptWithinSession((signal) => prompt.confirm(
        "保留当前微信允许名单并加入本次扫码用户？",
        true,
        { signal },
      ))
      ? true
      : false;

    output.write("\n准备保存微信连接：\n");
    output.write(`- 账号 ID：${status.preview.accountId}\n`);
    output.write(`- 扫码用户：${status.preview.scannerId}\n`);
    output.write("- Bot Token：已获取（不显示）\n");
    output.write("- 运行状态：已配置，默认未启用\n");
    if (!await promptWithinSession((signal) =>
      prompt.confirm("确认安全保存以上连接？", true, { signal }))) {
      session.cancel(ownerId);
      output.write("未保存微信连接；本次 Token 已丢弃。\n");
      return undefined;
    }

    const result = await session.confirm(ownerId, {
      preserveExistingAllowedUsers,
    });
    if (result.warnings.some((warning) =>
      warning.code === "old-credential-cleanup-failed")) {
      output.write("微信新连接已保存，但旧账号本地凭据清理失败；请运行 codexc doctor 检查。\n");
    }

    output.write(`\n微信连接已安全保存：${result.configPath}\n`);
    writeGatewayConfigActivationNotice(output);
    output.write(
      "如需启用消息接收，请将 weixin.enabled 改为 true，然后运行 codexc service reload。\n",
    );
    return {
      accountId: result.accountId,
      allowedUserIds: result.allowedUserIds,
      configPath: result.configPath,
    };
  } finally {
    unsubscribe?.();
    if (session) {
      const status = session.status(ownerId);
      if (!["saved", "cancelled", "expired", "failed", "already-connected"]
        .includes(status.state)) {
        session.cancel(ownerId);
      }
    }
    prompt.close();
  }
}

function isTerminatedSetupStatus(status) {
  return ["expired", "cancelled", "failed"].includes(status.state);
}

function weixinSetupFailure(status) {
  const code = status.error?.code ?? status.state;
  const messages = {
    expired: "微信二维码登录合同验证超时",
    cancelled: "微信 Setup 已取消",
    "refresh-limit": "微信二维码刷新次数已达到上限",
    timeout: "微信二维码请求超时",
    "network-error": "微信二维码网络请求失败",
    "http-error": "微信二维码请求失败",
    "invalid-response": "微信二维码响应无效",
    "invalid-input": "微信二维码登录参数无效",
    aborted: "微信二维码登录已取消",
    "login-failed": "微信二维码登录失败",
  };
  return new WeixinSetupSessionError(
    code,
    "session",
    messages[code] ?? "微信二维码登录失败",
  );
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

function isDirectExecution(moduleUrl, argvPath) {
  return Boolean(argvPath) && moduleUrl === pathToFileURL(argvPath).href;
}

if (isDirectExecution(import.meta.url, process.argv[1])) {
  await runWeixinSetup().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
