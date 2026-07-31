import { pathToFileURL } from "node:url";

import * as clackPrompts from "@clack/prompts";

import { runFeishuSetup } from "./feishu-setup.mjs";
import { runDeepseekSetup } from "./deepseek-setup.mjs";
import { runTelegramSetup } from "./telegram-setup.mjs";
import { runWeixinSetup } from "./weixin-setup.mjs";

export async function runSetup({
  input = process.stdin,
  output = process.stdout,
  prompts = clackPrompts,
  feishuSetup = runFeishuSetup,
  deepseekSetup = runDeepseekSetup,
  telegramSetup = runTelegramSetup,
  weixinSetup = runWeixinSetup,
} = {}) {
  prompts.intro("Codex Connect Setup");
  const section = await prompts.select({
    message: "选择设置类别",
    showInstructions: false,
    options: [
      {
        value: "channels",
        label: "通讯渠道",
        hint: "配置外部消息入口",
      },
      {
        value: "models",
        label: "模型提供方",
        hint: "配置 OpenAI 与 DeepSeek",
      },
    ],
  });
  if (prompts.isCancel(section)) {
    prompts.cancel("Setup 已取消");
    return undefined;
  }
  switch (section) {
    case "channels":
      return runChannelSetup({
        input,
        output,
        prompts,
        feishuSetup,
        telegramSetup,
        weixinSetup,
      });
    case "models":
      return deepseekSetup({ input, output, prompts });
    default:
      throw new Error(`未知 Setup 类别：${String(section)}`);
  }
}

async function runChannelSetup({
  input,
  output,
  prompts,
  feishuSetup,
  telegramSetup,
  weixinSetup,
}) {
  const channel = await prompts.select({
    message: "选择通讯渠道",
    showInstructions: false,
    options: [
      {
        value: "telegram",
        label: "Telegram",
        hint: "Bot、用户授权与消息格式",
      },
      {
        value: "feishu",
        label: "飞书",
        hint: "企业自建应用与用户授权",
      },
      {
        value: "weixin",
        label: "微信",
        hint: "扫码连接与用户授权",
      },
    ],
  });
  if (prompts.isCancel(channel)) {
    prompts.cancel("Setup 已取消");
    return undefined;
  }
  switch (channel) {
    case "telegram":
      return telegramSetup({ input, output });
    case "feishu":
      return feishuSetup({ input, output });
    case "weixin":
      return weixinSetup({ input, output });
    default:
      throw new Error(`未知通讯渠道：${String(channel)}`);
  }
}

function isDirectExecution(moduleUrl, argvPath) {
  return Boolean(argvPath) && moduleUrl === pathToFileURL(argvPath).href;
}

if (isDirectExecution(import.meta.url, process.argv[1])) {
  await runSetup().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
