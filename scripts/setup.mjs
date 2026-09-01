import { pathToFileURL } from "node:url";

import * as clackPrompts from "@clack/prompts";

import { writeCliMessage } from "../runtime/cli-presentation.mjs";
import { runFeishuSetup } from "./feishu-setup.mjs";
import { runDeepseekSetup } from "./deepseek-setup.mjs";
import { runTelegramSetup } from "./telegram-setup.mjs";
import { runWeixinSetup } from "./weixin-setup.mjs";
import { runApiProviderSetup } from "./api-provider-setup.mjs";
import { runSkillSetup } from "./skill-setup.mjs";
import { runCodexDefaultsSetup } from "./codex-defaults-setup.mjs";
import { runCodexUserSettingsSetup } from "./codex-user-settings-setup.mjs";
import { runOpenCodeGoSetup } from "./opencode-go-setup.mjs";
import { runModelProviderDefaultSetup } from "./model-provider-default-setup.mjs";
import { runCustomPrimaryProviderMenu } from "./primary-provider-cli.mjs";
import { runOfficialLoginSetup } from "./official-login-setup.mjs";
import { writeSetupConfigurationSummary } from "./setup-summary.mjs";
import { runThirdPartyAgentSetup } from "./agents-setup.mjs";
import { configActivationResult } from "./config-activation-result.mjs";

export async function runSetup({
  environment = process.env,
  input = process.stdin,
  output = process.stdout,
  prompts = clackPrompts,
  feishuSetup = runFeishuSetup,
  deepseekSetup = runDeepseekSetup,
  telegramSetup = runTelegramSetup,
  weixinSetup = runWeixinSetup,
  apiProviderSetup = runApiProviderSetup,
  skillSetup = runSkillSetup,
  codexDefaultsSetup = runCodexDefaultsSetup,
  codexUserSettingsSetup = runCodexUserSettingsSetup,
  openCodeGoSetup = runOpenCodeGoSetup,
  modelProviderDefaultSetup = runModelProviderDefaultSetup,
  customPrimarySetup = runCustomPrimaryProviderMenu,
  officialLoginSetup = runOfficialLoginSetup,
  setupSummary = writeSetupConfigurationSummary,
  agentsSetup = runThirdPartyAgentSetup,
  stayOnMenu = false,
} = {}) {
  prompts.intro("Codex Connect Setup");
  while (true) {
    const section = await prompts.select({
      message: "选择设置类别",
      showInstructions: false,
      options: [
        {
          value: "summary",
          label: "配置总览",
          hint: "脱敏显示 Provider、模型、共享子代理、通讯渠道与用户技能状态",
        },
        {
          value: "codex_user",
          label: "Codex 新会话默认值",
          hint: "OpenAI 官方默认模型、思考等级、Fast、权限与用户偏好",
        },
        {
          value: "models",
          label: "模型与提供商",
          hint: "管理 OpenAI、第三方 Provider 与模型默认值",
        },
        {
          value: "channels",
          label: "通讯渠道",
          hint: "配置外部消息入口",
        },
        {
          value: "skills",
          label: "项目技能",
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
      case "summary":
        await setupSummary({ output });
        continue;
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
        if (stayOnMenu) continue;
        return enrichSetupResult(result, "restart-gateway");
      }
      case "codex_user": {
        const result = await codexUserSettingsSetup({
          environment,
          output,
          prompts,
          defaultsSetup: codexDefaultsSetup,
        });
        if (isBackResult(result)) continue;
        if (stayOnMenu) continue;
        return enrichSetupResult(result, "restart-all");
      }
      case "models": {
        const result = await runModelSetup({
          input,
          output,
          prompts,
          deepseekSetup,
          apiProviderSetup,
          openCodeGoSetup,
          modelProviderDefaultSetup,
          customPrimarySetup,
          officialLoginSetup,
          agentsSetup,
        });
        if (isBackResult(result)) continue;
        if (stayOnMenu) continue;
        return enrichSetupResult(result);
      }
      case "skills": {
        const result = await skillSetup({
          input,
          output,
          prompts,
        });
        if (isBackResult(result)) continue;
        if (stayOnMenu) continue;
        return enrichSetupResult(result);
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
  openCodeGoSetup,
  modelProviderDefaultSetup,
  customPrimarySetup,
  officialLoginSetup,
  agentsSetup,
}) {
  while (true) {
    const category = await prompts.select({
      message: "选择模型与提供商设置",
      showInstructions: false,
      options: [
        {
          value: "official",
          label: "OpenAI 官方",
          hint: "OpenAI 官方登录与固定主 Provider 恢复",
        },
        {
          value: "third_party",
          label: "第三方 Provider",
          hint: "自定义 Responses、DeepSeek 官方、OpenCode Go 官方等",
        },
        { value: "back", label: "返回", hint: "返回设置类别" },
      ],
    });
    if (prompts.isCancel(category) || category === "back") return { action: "back" };
    if (category === "official") {
      const result = await runOfficialModelSetup({
        input,
        output,
        prompts,
        officialLoginSetup,
      });
      if (isBackResult(result)) continue;
      return enrichSetupResult(result, "restart-all");
    }
    if (category === "third_party") {
      const result = await runThirdPartyModelSetup({
        input,
        output,
        prompts,
        deepseekSetup,
        apiProviderSetup,
        openCodeGoSetup,
        modelProviderDefaultSetup,
        customPrimarySetup,
        agentsSetup,
      });
      if (isBackResult(result)) continue;
      return enrichSetupResult(result, "restart-all");
    }
    throw new Error(`未知模型与提供商设置：${String(category)}`);
  }
}

async function runOfficialModelSetup({
  input,
  output,
  prompts,
  officialLoginSetup,
}) {
  while (true) {
    const module = await prompts.select({
      message: "OpenAI 官方设置",
      showInstructions: false,
      options: [
        {
          value: "official_login",
          label: "登录并恢复官方",
          hint: "运行 codex login --device-auth，并停用自定义固定主 Provider",
        },
        { value: "back", label: "返回", hint: "返回模型与提供商菜单" },
      ],
    });
    if (prompts.isCancel(module) || module === "back") return { action: "back" };
    let result;
    if (module === "official_login") {
      result = await officialLoginSetup({ input, output, prompts });
    } else {
      throw new Error(`未知官方设置：${String(module)}`);
    }
    if (isBackResult(result)) continue;
    return enrichSetupResult(result, "restart-all");
  }
}

async function runThirdPartyModelSetup({
  input,
  output,
  prompts,
  deepseekSetup,
  apiProviderSetup,
  openCodeGoSetup,
  modelProviderDefaultSetup,
  customPrimarySetup,
  agentsSetup,
}) {
  while (true) {
    const module = await prompts.select({
      message: "第三方 Provider 设置",
      showInstructions: false,
      options: [
        {
          value: "custom_primary",
          label: "自定义 Responses Provider",
          hint: "管理固定或切换模式的 OpenAI Responses 兼容 Provider",
        },
        {
          value: "deepseek",
          label: "DeepSeek 官方",
          hint: "安装、切换、恢复或修改模型设置（思考等级、自动压缩）",
        },
        {
          value: "opencode-go",
          label: "OpenCode Go 官方",
          hint: "安装、移除或修改模型设置（思考等级、自动压缩）",
        },
        {
          value: "provider_default",
          label: "受管 Provider 模型设置",
          hint: "设置 DeepSeek 与 OpenCode Go 的模型、思考等级和自动压缩",
        },
        {
          value: "agents",
          label: "共享第三方子代理",
          hint: "选择已配置 Provider 与模型，或停用 agents.external",
        },
        {
          value: "api_provider",
          label: "直接 API Provider（预留）",
          hint: "只保存未来直接 API 注册；不进入 App Server 或 /model",
        },
        { value: "back", label: "返回", hint: "返回模型与提供商菜单" },
      ],
    });
    if (prompts.isCancel(module) || module === "back") return { action: "back" };
    let result;
    if (module === "deepseek") {
      result = await deepseekSetup({ input, output, prompts, allowBack: true });
    } else if (module === "opencode-go") {
      result = await openCodeGoSetup({ input, output, prompts, allowBack: true });
    } else if (module === "custom_primary") {
      result = await customPrimarySetup({ input, output, prompts, allowBack: true });
    } else if (module === "provider_default") {
      result = await modelProviderDefaultSetup({ input, output, prompts, allowBack: true });
    } else if (module === "agents") {
      result = await agentsSetup({ input, output, prompts, allowBack: true });
    } else if (module === "api_provider") {
      result = await apiProviderSetup({ input, output, prompts });
    } else {
      throw new Error(`未知第三方设置：${String(module)}`);
    }
    if (isBackResult(result)) continue;
    return enrichSetupResult(result, setupFallbackActivation(module, result));
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

function enrichSetupResult(value, fallbackActivation) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  if (value.activationResult !== undefined) {
    return value;
  }
  const activation = typeof value.activation === "string"
    ? value.activation
    : fallbackActivation;
  if (typeof activation !== "string") return value;
  return {
    ...value,
    activation,
    activationResult: configActivationResult(activation),
  };
}

function setupFallbackActivation(module, result) {
  if (module === "opencode-go" && ["listed", "not-running", "in-use"].includes(result?.action)) {
    return undefined;
  }
  if (module === "opencode-go" && result?.action === "model-settings") {
    return "restart-app-server";
  }
  return {
    custom_primary: "restart-all",
    deepseek: "restart-all",
    "opencode-go": "restart-all",
    provider_default: "restart-app-server",
    agents: "restart-all",
    api_provider: "restart-gateway",
  }[module];
}

function isDirectExecution(moduleUrl, argvPath) {
  return Boolean(argvPath) && moduleUrl === pathToFileURL(argvPath).href;
}

if (isDirectExecution(import.meta.url, process.argv[1])) {
  await runSetup({ stayOnMenu: true }).catch((error) => {
    writeCliMessage("failure", error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
