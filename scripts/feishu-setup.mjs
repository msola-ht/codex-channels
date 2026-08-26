import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

import qrcode from "qrcode";

import { writeGatewayConfigActivationNotice } from "./config-activation-notice.mjs";
import {
  FeishuSetupSessionError,
  createFeishuSetupSession,
  normalizeOpenIds,
} from "./feishu-setup-session.mjs";
import { createPrompter } from "./terminal-prompter.mjs";

const appIdPattern = /^cli_[0-9a-fA-F]{16}$/u;
const defaultTimeoutSeconds = 600;

export { normalizeOpenIds };

export async function runFeishuSetup({
  environment = process.env,
  input = process.stdin,
  output = process.stdout,
  prompter,
  registerApplication,
  validateApplication,
  configureApplication,
  renderQRCode = renderTerminalQRCode,
  timeoutSeconds = defaultTimeoutSeconds,
  createSetupSession = createFeishuSetupSession,
} = {}) {
  const prompt = prompter ?? createPrompter(input, output);
  const ownerId = `codexc-setup:${randomUUID()}`;
  let session;
  let unsubscribe;
  let promptAbortController;

  const promptWithinSession = async (operation) => {
    const before = session.status(ownerId);
    if (isTerminatedSetupStatus(before)) throw feishuSetupFailure(before);
    const controller = new AbortController();
    promptAbortController = controller;
    try {
      const value = await operation(controller.signal);
      const after = session.status(ownerId);
      if (isTerminatedSetupStatus(after)) throw feishuSetupFailure(after);
      return value;
    } catch (error) {
      const current = session.status(ownerId);
      if (isTerminatedSetupStatus(current)) throw feishuSetupFailure(current);
      throw error;
    } finally {
      if (promptAbortController === controller) promptAbortController = undefined;
    }
  };

  try {
    output.write("\nCodex Connect 飞书 Setup\n\n");
    output.write("1. 手动输入应用凭据\n");
    output.write("2. 扫码授权\n");
    const choice = await askChoice(prompt, "请选择 [1-2]", 2);
    const mode = choice === "2" ? "scan" : "manual";
    let manualCredential;
    if (choice === "1") {
      manualCredential = await readManualRegistration(prompt, output);
    } else {
      output.write("\n扫码后请在飞书授权页选择新建应用或已有应用。\n");
      output.write("扫码只用于本次注册；短期授权信息不会保存。\n");
    }

    session = createSetupSession({
      ownerId,
      timeoutMs: timeoutSeconds * 1_000,
    }, {
      environment,
      ...(registerApplication === undefined ? {} : { registerApplication }),
      ...(validateApplication === undefined ? {} : { validateApplication }),
      ...(configureApplication === undefined ? {} : { configureApplication }),
    });
    let authorizationUrl;
    unsubscribe = session.subscribe(ownerId, (status) => {
      if (
        status.authorization?.url
        && status.authorization.url !== authorizationUrl
      ) {
        authorizationUrl = status.authorization.url;
        output.write("\n请使用飞书扫描下面的二维码，并在确认页完成授权：\n\n");
        renderQRCode(authorizationUrl, output);
        output.write(
          `\n二维码有效期约 ${status.authorization.expiresInSeconds} 秒。\n`,
        );
        output.write(`无法扫码时可在浏览器打开：${authorizationUrl}\n\n`);
      }
      if (isTerminatedSetupStatus(status)) promptAbortController?.abort();
    });
    session.start(ownerId, mode === "scan"
      ? { mode }
      : { mode, ...manualCredential });
    let status = await session.waitForReady(ownerId);
    if (
      !new Set(["validated", "ready"]).has(status.state)
      || !status.application
    ) {
      throw feishuSetupFailure(status);
    }

    let allowedOpenIds = status.preview?.allowedOpenIds;
    if (mode === "manual") {
      const existingAllowedOpenIds = status.application
        .configuredAllowedOpenIds ?? [];
      if (
        existingAllowedOpenIds.length > 0
        && await promptWithinSession((signal) => prompt.confirm(
          "保留当前允许名单？",
          true,
          { signal },
        ))
      ) {
        allowedOpenIds = [...existingAllowedOpenIds];
      }
      allowedOpenIds = await collectAllowedOpenIds(
        prompt,
        output,
        allowedOpenIds,
        (operation) => promptWithinSession(operation),
      );
      status = session.useAllowedOpenIds(ownerId, allowedOpenIds);
    }
    const preview = status.preview;
    if (!preview) throw feishuSetupFailure(status);

    output.write("\n准备保存飞书配置：\n");
    output.write("- 状态：启用\n");
    output.write(`- App ID：${preview.appId}\n`);
    output.write(`- Bot：${preview.botName}\n`);
    output.write("- App Secret：已获取（不显示）\n");
    output.write(`- 允许用户：${preview.allowedOpenIds.join(", ")}\n`);
    if (!await promptWithinSession((signal) => prompt.confirm(
      "确认保存以上配置？",
      true,
      { signal },
    ))) {
      session.cancel(ownerId);
      output.write("未保存飞书配置。\n");
      return undefined;
    }

    const result = await session.confirm(ownerId);
    output.write(`\n飞书配置已保存：${result.configPath}\n`);
    if (mode === "scan") {
      output.write("正在自动配置并发布飞书机器人悬浮菜单…\n");
      if (result.applicationConfiguration !== "failed") {
        output.write(
          result.applicationConfiguration === "updated"
            ? "飞书机器人配置已提交发布；请运行 codexc doctor 确认权限、消息事件和版本均已生效。\n"
            : "飞书机器人配置无需修改；请运行 codexc doctor 确认权限、消息事件和版本均已生效。\n",
        );
      } else {
        output.write(
          "飞书连接配置已保存，但机器人菜单自动配置未完成；"
          + "机器人可能无法接收消息。请先运行 codexc doctor；"
          + "再重新运行 codexc setup，选择扫码授权并在飞书页面选择当前应用，"
          + "确认全部权限、事件和发布步骤。配置完成前不能依赖 /fs doctor 恢复。\n",
        );
      }
    }
    output.write("下一步运行：codexc doctor\n");
    if (mode === "manual") {
      output.write(
        "请先运行 codexc doctor 检查飞书权限和消息事件；"
        + "如有缺失，请重新运行 codexc setup，选择扫码授权并在飞书页面选择当前应用。\n",
      );
    }
    writeGatewayConfigActivationNotice(output);
    return {
      appId: result.appId,
      allowedOpenIds: result.allowedOpenIds,
      configPath: result.configPath,
    };
  } finally {
    unsubscribe?.();
    if (session) {
      const status = session.status(ownerId);
      if (!new Set(["saved", "cancelled", "expired", "failed"])
        .has(status.state)) {
        session.cancel(ownerId);
      }
    }
    prompt.close();
  }
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

async function collectAllowedOpenIds(prompt, output, initial = [], runPrompt) {
  while (true) {
    const entered = await runPrompt((signal) => prompt.ask(
      initial.length === 0
        ? "允许的用户 Open ID（多个用逗号分隔）"
        : "其他允许的用户 Open ID（可选，多个用逗号分隔）",
      { signal },
    ));
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

function renderTerminalQRCode(url, output) {
  qrcode.toString(url, { type: "terminal", small: true }, (error, rendered) => {
    if (error) {
      output.write(`二维码渲染失败：${error.message}\n`);
      return;
    }
    output.write(`${rendered}\n`);
  });
}

async function askChoice(prompt, label, maximum) {
  while (true) {
    const choice = await prompt.ask(label);
    if (new RegExp(`^[1-${maximum}]$`).test(choice)) {
      return choice;
    }
  }
}

function isTerminatedSetupStatus(status) {
  return ["expired", "cancelled", "failed"].includes(status.state);
}

function feishuSetupFailure(status) {
  const code = status.error?.code ?? status.state;
  const messages = {
    expired: "飞书扫码授权已过期，请重新运行 Setup",
    cancelled: "飞书扫码授权已取消或超时",
    "access-denied": "飞书扫码授权已被拒绝",
    "registration-failed": "飞书扫码注册失败",
    "invalid-registration": "飞书扫码注册返回无效",
    "unsupported-tenant": "当前项目暂不支持 Lark 租户",
    "validation-failed": "飞书应用凭据或机器人身份验证失败",
    "save-failed": "飞书配置保存失败",
  };
  return new FeishuSetupSessionError(
    code,
    "session",
    messages[code] ?? "飞书 Setup 失败",
  );
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
