import { pathToFileURL } from "node:url";

import * as clackPrompts from "@clack/prompts";

import { writeCliMessage } from "../runtime/cli-presentation.mjs";
import { runFeishuSetup } from "./feishu-setup.mjs";
import { runDeepseekSetup } from "./deepseek-setup.mjs";
import { runTelegramSetup } from "./telegram-setup.mjs";
import { runWeixinSetup } from "./weixin-setup.mjs";
import { runVisionSetup } from "./vision-setup.mjs";
import { runApiProviderSetup } from "./api-provider-setup.mjs";
import { runSkillSetup } from "./skill-setup.mjs";
import { runCodexDefaultsSetup } from "./codex-defaults-setup.mjs";
import { runOpenCodeGoSetup } from "./opencode-go-setup.mjs";
import { runModelProviderDefaultSetup } from "./model-provider-default-setup.mjs";

export async function runSetup({
  input = process.stdin,
  output = process.stdout,
  prompts = clackPrompts,
  feishuSetup = runFeishuSetup,
  deepseekSetup = runDeepseekSetup,
  telegramSetup = runTelegramSetup,
  weixinSetup = runWeixinSetup,
  visionSetup = runVisionSetup,
  apiProviderSetup = runApiProviderSetup,
  skillSetup = runSkillSetup,
  codexDefaultsSetup = runCodexDefaultsSetup,
  openCodeGoSetup = runOpenCodeGoSetup,
  modelProviderDefaultSetup = runModelProviderDefaultSetup,
} = {}) {
  prompts.intro("Codex Connect Setup");
  while (true) {
    const section = await prompts.select({
      message: "选择设置类别",
      showInstructions: false,
      options: [
        {
          value: "models",
          label: "模型与提供商",
          hint: "设置 Codex 官方默认值、第三方模型、API 与图片识别",
        },
        {
          value: "channels",
          label: "通讯渠道",
          hint: "配置外部消息入口",
        },
        {
          value: "skills",
          label: "技能",
          hint: "安装或卸载项目技能到用户目录",
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
          apiProviderSetup,
          visionSetup,
          codexDefaultsSetup,
          openCodeGoSetup,
          modelProviderDefaultSetup,
        });
        if (isBackResult(result)) continue;
        return result;
      }
      case "skills": {
        const result = await skillSetup({
          input,
          output,
          prompts,
        });
        if (isBackResult(result)) continue;
        return result;
      }
      default:
        throw new Error(`未知 Setup 类别：${String(section)}`);
    }
  }
}

async function runModelSetup({
  input,
  output,
  prompts,
  deepseekSetup,
  apiProviderSetup,
  visionSetup,
  codexDefaultsSetup,
  openCodeGoSetup,
  modelProviderDefaultSetup,
}) {
  const module = await prompts.select({
    message: "选择模型与提供商设置",
    showInstructions: false,
    options: [
      {
        value: "codex",
        label: "Codex 官方",
        hint: "设置全局默认模型与思考等级",
      },
      { value: "deepseek", label: "DeepSeek", hint: "安装、切换或恢复模型提供商" },
      { value: "opencode-go", label: "OpenCode Go", hint: "安装或移除独立 Go Provider" },
      {
        value: "provider_default",
        label: "第三方模型设置",
        hint: "按 Provider 和模型设置默认值、思考等级与自动压缩",
      },
      {
        value: "api_provider",
        label: "第三方 API",
        hint: "管理供图片识别等功能使用的 Responses 中转接口",
      },
      { value: "vision", label: "图片识别", hint: "为不支持图片的模型配置视觉代理" },
      { value: "back", label: "返回", hint: "返回设置类别" },
    ],
  });
  if (prompts.isCancel(module) || module === "back") return { action: "back" };
  if (module === "codex") {
    return codexDefaultsSetup({ input, output, prompts, allowBack: true });
  }
  if (module === "deepseek") {
    return deepseekSetup({ input, output, prompts, allowBack: true });
  }
  if (module === "opencode-go") {
    return openCodeGoSetup({ input, output, prompts, allowBack: true });
  }
  if (module === "provider_default") {
    return modelProviderDefaultSetup({ input, output, prompts, allowBack: true });
  }
  if (module === "api_provider") {
    return apiProviderSetup({ input, output, prompts });
  }
  if (module === "vision") return visionSetup({ input, output, prompts });
  throw new Error(`未知模型与提供商设置：${String(module)}`);
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
    writeCliMessage("failure", error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
