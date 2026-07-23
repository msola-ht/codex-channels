import { randomBytes } from "node:crypto";
import { chmodSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";

import { parse } from "dotenv";
import { Bot } from "grammy";
import { HttpsProxyAgent } from "https-proxy-agent";

import { requireUserConfig } from "./runtime-config.mjs";

const tokenPattern = /^\d+:[A-Za-z0-9_-]{30,}$/;
const userIdPattern = /^\d+$/;

export async function runTelegramSetup({
  environment = process.env,
  input = process.stdin,
  output = process.stdout,
  createClient = createTelegramClient,
  createPairingCode = generatePairingCode,
  waitSeconds = 120,
  prompter,
} = {}) {
  const { envPath } = requireUserConfig(environment);
  const original = readFileSync(envPath, "utf8");
  const existing = parse(original);
  const prompt = prompter ?? createPrompter(input, output);

  try {
    output.write("\nCodex Connect Telegram Setup\n\n");
    output.write("1. 新建 Telegram Bot（通过官方 @BotFather）\n");
    output.write("2. 使用已有 Telegram Bot\n");
    if (existing.TELEGRAM_BOT_TOKEN?.trim()) {
      output.write("3. 保留当前配置的 Telegram Bot\n");
    }

    const maximumChoice = existing.TELEGRAM_BOT_TOKEN?.trim() ? 3 : 2;
    const choice = await askChoice(prompt, `请选择 [1-${maximumChoice}]`, maximumChoice);
    const botSource = choice === "1" ? "new" : choice === "2" ? "existing" : "configured";
    let token;
    if (choice === "3") {
      token = existing.TELEGRAM_BOT_TOKEN.trim();
    } else {
      if (choice === "1") {
        output.write("\n请在 Telegram 打开 https://t.me/BotFather：\n");
        output.write("1. 发送 /newbot\n2. 设置显示名称\n3. 设置以 bot 结尾的唯一用户名\n4. 复制 BotFather 返回的 Token\n\n");
      }
      token = await askToken(prompt, output);
    }

    const proxyUrl = resolveTelegramProxy(environment);
    let client;
    let bot;
    try {
      client = createClient(token, proxyUrl);
      bot = await client.getMe();
    } catch (error) {
      throw new Error(`Telegram Bot 验证请求失败：${safeErrorMessage(error, token)}`);
    }
    output.write(`已验证 Telegram Bot：@${bot.username}\n`);

    let allowedUserIds;
    const reusingConfiguredBot = token === existing.TELEGRAM_BOT_TOKEN?.trim();
    const configuredUserIds = validConfiguredUserIds(existing.TELEGRAM_ALLOWED_USER_IDS);
    if (
      reusingConfiguredBot
      && configuredUserIds
      && await prompt.confirm(`保留当前允许的用户 ID（${configuredUserIds}）？`, true)
    ) {
      allowedUserIds = configuredUserIds;
    }

    let discoverAutomatically = false;
    if (!allowedUserIds && reusingConfiguredBot) {
      output.write("当前 Bot 可能正在被 Gateway 长轮询；同时获取更新会产生 Telegram 409 冲突。\n");
      output.write("自动获取还会确认并移除该 Bot 当前积压的待处理更新。\n");
      discoverAutomatically = await prompt.confirm("已停止使用该 Bot 的 Gateway，并继续自动获取用户 ID？", false);
    } else if (!allowedUserIds && botSource === "existing") {
      output.write("已有 Bot 可能正被其他程序长轮询；同时获取更新会产生 Telegram 409 冲突。\n");
      output.write("自动获取还会确认并移除该 Bot 当前积压的待处理更新。\n");
      discoverAutomatically = await prompt.confirm("确认该 Bot 未被其他程序使用，并继续自动获取用户 ID？", false);
    } else if (!allowedUserIds) {
      discoverAutomatically = await prompt.confirm("是否通过给 Bot 发送消息自动获取你的用户 ID？", true);
    }

    if (discoverAutomatically) {
      try {
        const offset = await discardPendingMessageUpdates(client);
        const pairingCode = createPairingCode();
        const pairingLink = `https://t.me/${bot.username}?start=${encodeURIComponent(pairingCode)}`;
        output.write(`\n请现在打开 ${pairingLink}，点击 Start 完成一次性配对。\n`);
        output.write("等待消息期间，请确保没有其他程序使用同一个 Bot Token 进行长轮询。\n");
        const sender = await waitForPrivateSender(client, waitSeconds, offset, pairingCode);
        const label = sender.username ? `@${sender.username}` : sender.displayName || "未知用户";
        output.write(`检测到 Telegram 用户：${label}（ID：${sender.id}）\n`);
        if (await prompt.confirm("使用这个用户 ID？", true)) {
          while (!allowedUserIds) {
            const additional = await prompt.ask("其他允许的用户 ID（可选，多个用逗号分隔）");
            try {
              allowedUserIds = normalizeUserIds([sender.id, ...additional.split(",")]);
            } catch (error) {
              output.write(`${errorMessage(error)}\n`);
            }
          }
        }
      } catch (error) {
        output.write(`自动获取用户 ID 失败：${safeErrorMessage(error, token)}\n`);
      }
    }

    if (!allowedUserIds) {
      output.write("可向 Telegram 的 @userinfobot 发送消息查看数字用户 ID。\n");
      while (!allowedUserIds) {
        const entered = await prompt.ask("允许的用户 ID（多个用逗号分隔）");
        try {
          allowedUserIds = normalizeUserIds(entered.split(","));
        } catch (error) {
          output.write(`${errorMessage(error)}\n`);
        }
      }
    }

    const updated = setEnvValues(original, {
      TELEGRAM_BOT_TOKEN: token,
      TELEGRAM_ALLOWED_USER_IDS: allowedUserIds,
    });
    writeEnvironmentAtomically(envPath, updated);
    output.write(`\nTelegram 配置已保存：${envPath}\n`);
    output.write("下一步运行：codexc doctor\n");
    output.write("如 Gateway 已安装并正在运行，再运行：codexc service restart\n");
    return { botUsername: bot.username, allowedUserIds, envPath };
  } finally {
    prompt.close();
  }
}

export async function discardPendingMessageUpdates(client, maximumPages = 100) {
  let offset = 0;
  for (let page = 0; page < maximumPages; page += 1) {
    const updates = await client.getUpdates({
      offset,
      timeout: 0,
      limit: 100,
      allowed_updates: ["message"],
    });
    offset = nextOffset(updates, offset);
    if (updates.length < 100) {
      return offset;
    }
  }
  const remaining = await client.getUpdates({
    offset,
    timeout: 0,
    limit: 1,
    allowed_updates: ["message"],
  });
  if (remaining.length === 0) {
    return offset;
  }
  throw new Error(`历史消息更新超过 ${maximumPages * 100} 条，无法安全定位新的 /start`);
}

export async function waitForPrivateSender(client, waitSeconds = 120, initialOffset = 0, pairingCode) {
  if (!pairingCode) {
    throw new Error("缺少 Telegram 一次性配对码");
  }
  let offset = initialOffset;
  const deadline = Date.now() + waitSeconds * 1_000;

  while (Date.now() < deadline) {
    const remaining = Math.max(1, Math.ceil((deadline - Date.now()) / 1_000));
    const updates = await client.getUpdates({
      offset,
      timeout: Math.min(20, remaining),
      limit: 100,
      allowed_updates: ["message"],
    });
    offset = nextOffset(updates, offset);
    for (const update of updates) {
      const message = update?.message;
      if (
        message?.chat?.type !== "private"
        || !message.from?.id
        || message.text?.trim() !== `/start ${pairingCode}`
      ) {
        continue;
      }
      return {
        id: String(message.from.id),
        username: message.from.username ? String(message.from.username) : undefined,
        displayName: [message.from.first_name, message.from.last_name].filter(Boolean).join(" "),
      };
    }
  }
  throw new Error(`等待 ${waitSeconds} 秒仍未收到私聊消息`);
}

export function normalizeUserIds(values) {
  const ids = [];
  for (const raw of values) {
    const value = String(raw).trim();
    if (!value) {
      continue;
    }
    const numericId = Number(value);
    if (!userIdPattern.test(value) || !Number.isSafeInteger(numericId) || numericId <= 0) {
      throw new Error(`无效的 Telegram 用户 ID：${value}`);
    }
    if (!ids.includes(value)) {
      ids.push(value);
    }
  }
  if (ids.length === 0) {
    throw new Error("至少需要一个 Telegram 用户 ID");
  }
  return ids.join(",");
}

export function setEnvValues(content, values) {
  let lines = content.split(/\r?\n/);
  for (const [key, value] of Object.entries(values)) {
    const next = `${key}=${value}`;
    const pattern = new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=`);
    let replaced = false;
    lines = lines.filter((line) => {
      if (!pattern.test(line)) {
        return true;
      }
      if (replaced) {
        return false;
      }
      replaced = true;
      return true;
    }).map((line) => pattern.test(line) ? next : line);
    if (!replaced) {
      if (lines.at(-1) !== "") {
        lines.push("");
      }
      lines.push(next);
    }
  }
  return lines.join("\n");
}

export function resolveTelegramProxy(environment) {
  for (const key of ["TELEGRAM_PROXY_URL", "HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"]) {
    const value = environment[key]?.trim();
    if (value) {
      let parsed;
      try {
        parsed = new URL(value);
      } catch {
        throw new Error("TELEGRAM_PROXY_URL/HTTPS_PROXY 不是有效 URL");
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error("Telegram 代理目前只支持 http:// 或 https://");
      }
      return parsed.toString();
    }
  }
  return undefined;
}

export function isDirectExecution(moduleUrl, argvPath) {
  return Boolean(argvPath) && moduleUrl === pathToFileURL(argvPath).href;
}

function createTelegramClient(token, proxyUrl) {
  const bot = new Bot(token, {
    client: {
      timeoutSeconds: 25,
      ...(proxyUrl ? { baseFetchConfig: { agent: new HttpsProxyAgent(proxyUrl) } } : {}),
    },
  });
  return {
    getMe: () => bot.api.getMe(),
    getUpdates: (parameters) => bot.api.getUpdates(parameters),
  };
}

function createPrompter(input, output) {
  const readline = createInterface({ input, output });
  return {
    ask: async (label) => (await readline.question(`${label}：`)).trim(),
    secret: async (label) => {
      if (!input.isTTY || !output.isTTY) {
        return (await readline.question(`${label}：`)).trim();
      }
      output.write(`${label}：`);
      const originalWrite = readline._writeToOutput;
      readline._writeToOutput = () => {};
      try {
        return (await readline.question("")).trim();
      } finally {
        readline._writeToOutput = originalWrite;
        output.write("\n");
      }
    },
    confirm: async (label, defaultValue) => {
      const suffix = defaultValue ? "[Y/n]" : "[y/N]";
      const value = (await readline.question(`${label} ${suffix} `)).trim().toLowerCase();
      if (!value) {
        return defaultValue;
      }
      return value === "y" || value === "yes";
    },
    close: () => readline.close(),
  };
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
    const token = await prompt.secret("Telegram Bot Token");
    if (tokenPattern.test(token)) {
      return token;
    }
    output.write("Token 格式无效，应为 <数字>:<密钥>。\n");
  }
}

function nextOffset(updates, fallback) {
  return updates.reduce((maximum, update) => Math.max(maximum, Number(update.update_id) + 1), fallback);
}

function generatePairingCode() {
  return randomBytes(16).toString("base64url");
}

function validConfiguredUserIds(value) {
  if (!value?.trim()) {
    return undefined;
  }
  try {
    return normalizeUserIds(value.split(","));
  } catch {
    return undefined;
  }
}

function writeEnvironmentAtomically(envPath, content) {
  const temporaryPath = `${envPath}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, content, { mode: 0o600 });
  renameSync(temporaryPath, envPath);
  chmodSync(envPath, 0o600);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function safeErrorMessage(error, token) {
  return errorMessage(error).replaceAll(token, "[REDACTED]");
}

if (isDirectExecution(import.meta.url, process.argv[1])) {
  await runTelegramSetup().catch((error) => {
    console.error(errorMessage(error));
    process.exitCode = 1;
  });
}
