import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

import { readGatewayConfig } from "../runtime/gateway-config.mjs";
import { writeGatewayConfigActivationNotice } from "./config-activation-notice.mjs";
import { configActivationResult } from "./config-activation-result.mjs";
import { requireUserConfig } from "./runtime-config.mjs";
import {
  TelegramSetupSessionError,
  createTelegramSetupSession,
  discardPendingMessageUpdates,
  normalizeUserIds,
  resolveTelegramProxy,
  waitForPrivateSender,
} from "./telegram-setup-session.mjs";
import { createPrompter } from "./terminal-prompter.mjs";

const tokenPattern = /^\d+:[A-Za-z0-9_-]{30,}$/;

export {
  discardPendingMessageUpdates,
  normalizeUserIds,
  resolveTelegramProxy,
  waitForPrivateSender,
};

export async function runTelegramSetup({
  environment = process.env,
  input = process.stdin,
  output = process.stdout,
  createClient,
  createPairingCode,
  waitSeconds = 120,
  prompter,
  createSetupSession = createTelegramSetupSession,
} = {}) {
  const { configPath } = requireUserConfig(environment);
  const document = readGatewayConfig(configPath);
  const existing = table(document.telegram);
  const existingToken = stringValue(existing.bot_token);
  const prompt = prompter ?? createPrompter(input, output);
  const ownerId = `codexc-setup:${randomUUID()}`;
  let session;
  let unsubscribe;
  let promptAbortController;

  const promptWithinSession = async (operation) => {
    const before = session.status(ownerId);
    if (isTerminatedSetupStatus(before)) throw telegramSetupFailure(before);
    const controller = new AbortController();
    promptAbortController = controller;
    try {
      const value = await operation(controller.signal);
      const after = session.status(ownerId);
      if (isTerminatedSetupStatus(after)) throw telegramSetupFailure(after);
      return value;
    } catch (error) {
      const current = session.status(ownerId);
      if (isTerminatedSetupStatus(current)) throw telegramSetupFailure(current);
      throw error;
    } finally {
      if (promptAbortController === controller) promptAbortController = undefined;
    }
  };

  try {
    output.write("\nCodex Connect Telegram Setup\n\n");
    output.write("1. 新建 Telegram Bot（通过官方 @BotFather）\n");
    output.write("2. 使用已有 Telegram Bot\n");
    if (existingToken) {
      output.write("3. 保留当前配置的 Telegram Bot\n");
    }

    const maximumChoice = existingToken ? 3 : 2;
    const choice = await askChoice(prompt, `请选择 [1-${maximumChoice}]`, maximumChoice);
    const botSource = choice === "1" ? "new" : choice === "2" ? "existing" : "configured";
    let token;
    if (choice === "3") {
      token = existingToken;
    } else {
      if (choice === "1") {
        output.write("\n请在 Telegram 打开 https://t.me/BotFather：\n");
        output.write("1. 发送 /newbot\n2. 设置显示名称\n3. 设置以 bot 结尾的唯一用户名\n4. 复制 BotFather 返回的 Token\n\n");
      }
      token = await askToken(prompt, output);
    }

    session = createSetupSession({ ownerId }, {
      environment,
      ...(createClient === undefined ? {} : { createClient }),
      ...(createPairingCode === undefined ? {} : { createPairingCode }),
    });
    let pairingLink;
    unsubscribe = session.subscribe(ownerId, (status) => {
      if (status.pairing?.link && status.pairing.link !== pairingLink) {
        pairingLink = status.pairing.link;
        output.write(`\n请现在打开 ${pairingLink}，点击 Start 完成一次性配对。\n`);
        output.write("等待消息期间，请确保没有其他程序使用同一个 Bot Token 进行长轮询。\n");
      }
      if (isTerminatedSetupStatus(status)) promptAbortController?.abort();
    });
    session.start(ownerId, {
      source: botSource,
      ...(botSource === "configured" ? {} : { token }),
    });
    const validated = await session.waitForValidation(ownerId);
    if (validated.state !== "validated" || !validated.bot) {
      throw telegramSetupFailure(validated);
    }
    const bot = validated.bot;
    output.write(`已验证 Telegram Bot：@${bot.username}\n`);

    let allowedUserIds;
    const reusingConfiguredBot = bot.reusesConfiguredBot;
    const configuredUserIds = bot.configuredAllowedUserIds?.join(",");
    if (
      reusingConfiguredBot
      && configuredUserIds
      && await promptWithinSession((signal) => prompt.confirm(
        `保留当前允许的用户 ID（${configuredUserIds}）？`,
        true,
        { signal },
      ))
    ) {
      allowedUserIds = configuredUserIds;
    }

    let discoverAutomatically = false;
    if (!allowedUserIds && reusingConfiguredBot) {
      output.write("当前 Bot 可能正在被 Gateway 长轮询；同时获取更新会产生 Telegram 409 冲突。\n");
      output.write("自动获取还会确认并移除该 Bot 当前积压的待处理更新。\n");
      discoverAutomatically = await promptWithinSession((signal) =>
        prompt.confirm(
          "已停止使用该 Bot 的 Gateway，并继续自动获取用户 ID？",
          false,
          { signal },
        ));
    } else if (!allowedUserIds && botSource === "existing") {
      output.write("已有 Bot 可能正被其他程序长轮询；同时获取更新会产生 Telegram 409 冲突。\n");
      output.write("自动获取还会确认并移除该 Bot 当前积压的待处理更新。\n");
      discoverAutomatically = await promptWithinSession((signal) =>
        prompt.confirm(
          "确认该 Bot 未被其他程序使用，并继续自动获取用户 ID？",
          false,
          { signal },
        ));
    } else if (!allowedUserIds) {
      discoverAutomatically = await promptWithinSession((signal) =>
        prompt.confirm(
          "是否通过给 Bot 发送消息自动获取你的用户 ID？",
          true,
          { signal },
        ));
    }

    if (discoverAutomatically) {
      try {
        session.startPairing(ownerId, { waitSeconds });
        const paired = await session.waitForPairing(ownerId);
        const sender = paired.pairing?.sender;
        if (paired.state !== "sender-detected" || !sender) {
          throw telegramSetupFailure(paired);
        }
        const label = sender.username ? `@${sender.username}` : sender.displayName || "未知用户";
        output.write(`检测到 Telegram 用户：${label}（ID：${sender.id}）\n`);
        if (await promptWithinSession((signal) =>
          prompt.confirm("使用这个用户 ID？", true, { signal }))) {
          while (!allowedUserIds) {
            const additional = await promptWithinSession((signal) =>
              prompt.ask(
                "其他允许的用户 ID（可选，多个用逗号分隔）",
                { signal },
              ));
            try {
              allowedUserIds = normalizeUserIds([sender.id, ...additional.split(",")]);
            } catch (error) {
              output.write(`${errorMessage(error)}\n`);
            }
          }
        }
      } catch (error) {
        output.write(`自动获取用户 ID 失败：${errorMessage(error)}\n`);
      }
    }

    if (!allowedUserIds) {
      output.write("可向 Telegram 的 @userinfobot 发送消息查看数字用户 ID。\n");
      while (!allowedUserIds) {
        const entered = await promptWithinSession((signal) =>
          prompt.ask("允许的用户 ID（多个用逗号分隔）", { signal }));
        try {
          allowedUserIds = normalizeUserIds(entered.split(","));
        } catch (error) {
          output.write(`${errorMessage(error)}\n`);
        }
      }
    }

    session.useAllowedUserIds(ownerId, allowedUserIds.split(","));
    const result = await session.confirm(ownerId);
    output.write(`\nTelegram 配置已保存：${result.configPath}\n`);
    output.write("下一步运行：codexc doctor\n");
    writeGatewayConfigActivationNotice(output);
    return {
      botUsername: result.botUsername,
      allowedUserIds: result.allowedUserIds.join(","),
      configPath: result.configPath,
      activation: result.activation,
      activationResult: configActivationResult(result.activation),
    };
  } finally {
    unsubscribe?.();
    if (session) {
      const status = session.status(ownerId);
      if (!["saved", "cancelled", "expired", "failed"].includes(status.state)) {
        session.cancel(ownerId);
      }
    }
    prompt.close();
  }
}

export function isDirectExecution(moduleUrl, argvPath) {
  return Boolean(argvPath) && moduleUrl === pathToFileURL(argvPath).href;
}

async function askChoice(prompt, label, maximum) {
  while (true) {
    const choice = await prompt.ask(label);
    if (new RegExp(`^[1-${maximum}]$`).test(choice)) {
      return choice;
    }
  }
}

async function askToken(prompt, output) {
  while (true) {
    output.write("请输入 Telegram Bot Token（输入内容会显示，粘贴后按回车）。\n");
    const token = await prompt.secret("Telegram Bot Token");
    if (tokenPattern.test(token)) {
      return token;
    }
    output.write("Token 格式无效，应为 <数字>:<密钥>。\n");
  }
}

function table(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function stringValue(value) {
  return typeof value === "string" ? value.trim() : "";
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function isTerminatedSetupStatus(status) {
  return ["expired", "cancelled", "failed"].includes(status.state);
}

function telegramSetupFailure(status) {
  const code = status.error?.code ?? status.state;
  const messages = {
    expired: "Telegram Setup 已超时",
    cancelled: "Telegram Setup 已取消",
    "validation-failed": "Telegram Bot 验证请求失败",
    "save-failed": "Telegram 配置保存失败",
  };
  return new TelegramSetupSessionError(
    code,
    "session",
    messages[code] ?? "Telegram Setup 失败",
  );
}

if (isDirectExecution(import.meta.url, process.argv[1])) {
  await runTelegramSetup().catch((error) => {
    console.error(errorMessage(error));
    process.exitCode = 1;
  });
}
