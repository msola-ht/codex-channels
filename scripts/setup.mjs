import { pathToFileURL } from "node:url";

import * as clackPrompts from "@clack/prompts";

import { runFeishuSetup } from "./feishu-setup.mjs";
import { runDeepseekSetup } from "./deepseek-setup.mjs";
import { runTelegramSetup } from "./telegram-setup.mjs";
import { runWeixinSetup } from "./weixin-setup.mjs";
import { runVisionSetup } from "./vision-setup.mjs";
import { runDebugSetup } from "./debug-setup.mjs";

export async function runSetup({
  input = process.stdin,
  output = process.stdout,
  prompts = clackPrompts,
  feishuSetup = runFeishuSetup,
  deepseekSetup = runDeepseekSetup,
  telegramSetup = runTelegramSetup,
  weixinSetup = runWeixinSetup,
  visionSetup = runVisionSetup,
  debugSetup = runDebugSetup,
} = {}) {
  prompts.intro("Codex Connect Setup");
  while (true) {
    const section = await prompts.select({
      message: "选择设置类别",
      showInstructions: false,
      options: [
        {
          value: "models",
          label: "模型渠道",
          hint: "配置 OpenAI 与 DeepSeek",
        },
        {
          value: "channels",
          label: "通讯渠道",
          hint: "配置外部消息入口",
        },
        {
          value: "system",
          label: "系统设置",
          hint: "配置全局调试模式",
        },
        {
          value: "cancel",
          label: "取消",
          hint: "退出 Setup",
        },
      ],
    });
    if (prompts.isCancel(section) || section === "cancel") {
      prompts.cancel("Setup 已取消");
      return undefined;
    }
    switch (section) {
      case "channels": {
        const result = await runChannelSetup({
          input,
          output,
          prompts,
          feishuSetup,
          telegramSetup,
          weixinSetup,
        });
        if (isBackResult(result)) continue;
        return result;
      }
      case "models": {
        const result = await runModelSetup({
          input,
          output,
          prompts,
          deepseekSetup,
          visionSetup,
        });
        if (isBackResult(result)) continue;
        return result;
      }
      case "system": {
        const result = await runSystemSetup({
          input,
          output,
          prompts,
          debugSetup,
        });
        if (isBackResult(result)) continue;
        return result;
      }
      default:
        throw new Error(`未知 Setup 类别：${String(section)}`);
    }
  }
}

async function runSystemSetup({ input, output, prompts, debugSetup }) {
  const module = await prompts.select({
    message: "选择系统设置",
    showInstructions: false,
    options: [
      {
        value: "debug",
        label: "调试模式",
        hint: "控制全局脱敏调试日志和渠道技术字段",
      },
      { value: "back", label: "返回", hint: "返回设置类别" },
    ],
  });
  if (prompts.isCancel(module) || module === "back") return { action: "back" };
  if (module === "debug") return debugSetup({ input, output, prompts });
  throw new Error(`未知系统设置：${String(module)}`);
}

async function runModelSetup({ input, output, prompts, deepseekSetup, visionSetup }) {
  const module = await prompts.select({
    message: "选择模型渠道设置",
    showInstructions: false,
    options: [
      { value: "deepseek", label: "DeepSeek", hint: "安装、切换或恢复模型提供商" },
      { value: "vision", label: "图片识别", hint: "为不支持图片的模型配置视觉代理" },
      { value: "back", label: "返回", hint: "返回设置类别" },
    ],
  });
  if (prompts.isCancel(module) || module === "back") return { action: "back" };
  if (module === "deepseek") {
    return deepseekSetup({ input, output, prompts, allowBack: true });
  }
  if (module === "vision") return visionSetup({ input, output, prompts });
  throw new Error(`未知模型渠道设置：${String(module)}`);
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
      {
        value: "back",
        label: "返回",
        hint: "返回设置类别",
      },
    ],
  });
  if (prompts.isCancel(channel) || channel === "back") {
    return { action: "back" };
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

function isBackResult(result) {
  return result?.action === "back";
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
