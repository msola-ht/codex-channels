import { pathToFileURL } from "node:url";

import * as clackPrompts from "@clack/prompts";

import { ForwardedChildSignalError } from "../runtime/process-lifecycle.mjs";
import { writeCliMessage } from "../runtime/cli-presentation.mjs";
import { configActivationResult } from "./config-activation-result.mjs";

export async function runSetup({
  input = process.stdin,
  output = process.stdout,
  prompts = clackPrompts,
  feishuSetup = async (options) => (await import("./feishu-setup.mjs")).runFeishuSetup(options),
  deepseekSetup = async (options) => (await import("./deepseek-account-setup.mjs")).runDeepseekSetup(options),
  ccgSetup = async (options) => (await import("./ccg-setup.mjs")).runCcgSetup(options),
  clinePassSetup = async (options) => (await import("./cline-pass-setup.mjs")).runClinePassSetup(options),
  telegramSetup = async (options) => (await import("./telegram-setup.mjs")).runTelegramSetup(options),
  weixinSetup = async (options) => (await import("./weixin-setup.mjs")).runWeixinSetup(options),
  skillSetup = async (options) => (await import("./skill-setup.mjs")).runSkillSetup(options),
  openCodeGoSetup = async (options) => (await import("./opencode-go-setup.mjs")).runOpenCodeGoSetup(options),
  modelProviderDefaultSetup = async (options) => (await import("./model-provider-default-setup.mjs")).runModelProviderDefaultSetup(options),
  modelWindowSetup = async (options) => (await import("./model-window-setup.mjs")).runModelWindowSetup(options),
  customPrimarySetup = async (options) => (await import("./primary-provider-cli.mjs")).runCustomPrimaryProviderMenu(options),
  officialLoginSetup = async (options) => (await import("./official-login-setup.mjs")).runOfficialLoginSetup(options),
  setupSummary = async (options) => (await import("./setup-summary.mjs")).writeSetupConfigurationSummary(options),
  stayOnMenu = false,
  onResult,
} = {}) {
  if (!input.isTTY || !output.isTTY) {
    throw new Error("Setup 需要交互终端；请将标准输入和提示输出连接终端。--jsonl 仅改变结果输出格式。");
  }
  prompts.intro("接入向导");
  const selection = {
    section: "summary",
    modelCategory: "official",
    officialModule: "official_login",
    thirdPartyModule: "deepseek",
    channel: "telegram",
  };
  while (true) {
    const section = await prompts.select({
      message: "接入项目",
      showInstructions: false,
      initialValue: selection.section,
      options: [
        {
          value: "summary",
          label: "接入状态总览",
          hint: "脱敏查看模型、渠道与技能状态",
        },
        {
          value: "models",
          label: "模型与提供商",
          hint: "Provider 接入与受管模型设置",
        },
        {
          value: "channels",
          label: "通讯渠道",
          hint: "配置外部消息入口",
        },
        {
          value: "skills",
          label: "项目技能",
          hint: "安装或卸载用户目录中的项目技能",
        },
        {
          value: "complete",
          label: "完成接入",
          hint: "正常结束接入向导",
        },
        {
          value: "cancel",
          label: "取消",
          hint: "中止接入向导",
        },
      ],
    });
    if (prompts.isCancel(section) || section === "cancel") {
      prompts.cancel("已取消接入");
      emitSetupResult(onResult, undefined, undefined, "cancelled");
      return undefined;
    }
    if (section === "complete") {
      const result = { action: "completed" };
      prompts.outro("接入配置完成");
      emitSetupResult(onResult, undefined, result);
      return result;
    }
    if (!["summary", "channels", "models", "skills"].includes(section)) {
      throw new Error(`未知 Setup 类别：${String(section)}`);
    }
    selection.section = section;
    try {
      switch (section) {
        case "summary":
          await setupSummary({ output });
          continue;
        case "channels": {
          const result = await runChannelSetup({
            input,
            output,
            prompts,
            selection,
            feishuSetup,
            telegramSetup,
            weixinSetup,
          });
          if (isBackResult(result)) continue;
          const enriched = enrichSetupResult(result);
          emitSetupResult(onResult, "channels", enriched);
          if (stayOnMenu) continue;
          return enriched;
        }
        case "models": {
          const result = await runModelSetup({
            input,
            output,
            prompts,
            selection,
            deepseekSetup,
            ccgSetup,
            clinePassSetup,
            openCodeGoSetup,
            modelProviderDefaultSetup,
            modelWindowSetup,
            customPrimarySetup,
            officialLoginSetup,
          });
          if (isBackResult(result)) continue;
          const enriched = enrichSetupResult(result);
          emitSetupResult(onResult, "models", enriched);
          if (stayOnMenu) continue;
          return enriched;
        }
        case "skills": {
          const result = await skillSetup({
            input,
            output,
            prompts,
          });
          if (isBackResult(result)) continue;
          const enriched = enrichSetupResult(result);
          emitSetupResult(onResult, "skills", enriched);
          if (stayOnMenu) continue;
          return enriched;
        }
      }
    } catch (error) {
      if (!stayOnMenu || error instanceof ForwardedChildSignalError || error?.exitCode === 130 || error?.exitCode === 143) throw error;
      const event = sanitizeSetupEvent({
        event: "error", category: section,
        message: error instanceof Error ? error.message : String(error),
      });
      onResult?.(event);
      output.write(`[失败] ${event.message}\n`);
    }
  }
}

async function runModelSetup({
  input,
  output,
  prompts,
  selection,
  deepseekSetup,
  ccgSetup,
  clinePassSetup,
  openCodeGoSetup,
  modelProviderDefaultSetup,
  modelWindowSetup,
  customPrimarySetup,
  officialLoginSetup,
}) {
  while (true) {
    const category = await prompts.select({
      message: "模型与提供商",
      showInstructions: false,
      initialValue: selection.modelCategory,
      options: [
        {
          value: "official",
          label: "OpenAI 官方",
          hint: "登录与恢复官方 Provider",
        },
        {
          value: "third_party",
          label: "第三方 Provider",
          hint: "账户与自定义接入、受管模型设置",
        },
        { value: "back", label: "返回", hint: "返回设置类别" },
      ],
    });
    if (prompts.isCancel(category) || category === "back") return { action: "back" };
    if (category === "official") {
      selection.modelCategory = category;
      const result = await runOfficialModelSetup({
        input,
        output,
        prompts,
        selection,
        officialLoginSetup,
      });
      if (isBackResult(result)) continue;
      return result;
    }
    if (category === "third_party") {
      selection.modelCategory = category;
      const result = await runThirdPartyModelSetup({
        input,
        output,
        prompts,
        selection,
        deepseekSetup,
        ccgSetup,
        clinePassSetup,
        openCodeGoSetup,
        modelProviderDefaultSetup,
        modelWindowSetup,
        customPrimarySetup,
      });
      if (isBackResult(result)) continue;
      return result;
    }
    throw new Error(`未知模型与提供商设置：${String(category)}`);
  }
}

async function runOfficialModelSetup({
  input,
  output,
  prompts,
  selection,
  officialLoginSetup,
}) {
  while (true) {
    const module = await prompts.select({
      message: "OpenAI 官方",
      showInstructions: false,
      initialValue: selection.officialModule,
      options: [
        {
          value: "official_login",
          label: "登录并恢复官方",
          hint: "设备登录，并停用自定义固定主 Provider",
        },
        { value: "back", label: "返回", hint: "返回模型与提供商菜单" },
      ],
    });
    if (prompts.isCancel(module) || module === "back") return { action: "back" };
    let result;
    if (module === "official_login") {
      selection.officialModule = module;
      result = await officialLoginSetup({ input, output, prompts });
    } else {
      throw new Error(`未知官方设置：${String(module)}`);
    }
    if (isBackResult(result)) continue;
    return result;
  }
}

async function runThirdPartyModelSetup({
  input,
  output,
  prompts,
  selection,
  deepseekSetup,
  ccgSetup,
  clinePassSetup,
  openCodeGoSetup,
  modelProviderDefaultSetup,
  modelWindowSetup,
  customPrimarySetup,
}) {
  while (true) {
    const module = await prompts.select({
      message: "第三方 Provider",
      showInstructions: false,
      initialValue: selection.thirdPartyModule,
      options: [
        { value: "models", label: "模型管理", hint: "统一查看、添加、编辑、本地移除与默认设置" },
        {
          value: "deepseek",
          label: "DeepSeek 官方",
          hint: "账户、运行模式与模型设置",
        },
        {
          value: "opencode-go",
          label: "OpenCode Go 官方",
          hint: "账户、默认账户与模型设置",
        },
        {
          value: "ccg",
          label: "CommandCode Go 官方",
          hint: "DS 模型目录与固定/切换模式",
        },
        {
          value: "clp",
          label: "Cline Pass 官方",
          hint: "Chat 模型与固定/切换模式",
        },
        {
          value: "custom_primary",
          label: "Codex 兼容 Provider 接入",
          hint: "管理自定义接入，使用 Codex 官方模型目录",
        },
        {
          value: "custom_responses",
          label: "自定义模型 Provider 接入",
          hint: "管理自定义接入，手填独立模型目录与能力",
        },
        {
          value: "provider_default",
          label: "受管 Provider 默认模型与思考等级",
          hint: "按具体 Provider 独立设置默认模型与思考等级",
        },
        {
          value: "model_window",
          label: "受管模型目录上下文窗口",
          hint: "选择具体 Provider 与模型，独立设置上下文窗口",
        },
        { value: "back", label: "返回", hint: "返回模型与提供商菜单" },
      ],
    });
    if (prompts.isCancel(module) || module === "back") return { action: "back" };
    if (!["models", "deepseek", "opencode-go", "clp", "ccg", "custom_responses", "custom_primary", "provider_default", "model_window"].includes(module)) {
      throw new Error(`未知第三方设置：${String(module)}`);
    }
    selection.thirdPartyModule = module;
    let result;
    if (module === "models") {
      result = await (await import("./provider-model-setup.mjs")).runProviderModelSetup({ output, prompts });
    } else if (module === "deepseek") {
      result = await deepseekSetup({ input, output, prompts, allowBack: true });
    } else if (module === "opencode-go") {
      result = await openCodeGoSetup({ input, output, prompts, allowBack: true });
    } else if (module === "clp") {
      result = await clinePassSetup({ input, output, prompts, allowBack: true });
    } else if (module === "ccg") {
      result = await ccgSetup({ input, output, prompts, allowBack: true });
    } else if (module === "custom_responses") {
      result = await customPrimarySetup({ input, output, prompts, allowBack: true, catalogKind: "custom" });
    } else if (module === "custom_primary") {
      result = await customPrimarySetup({ input, output, prompts, allowBack: true });
    } else if (module === "provider_default") {
      result = await modelProviderDefaultSetup({ input, output, prompts, allowBack: true });
    } else if (module === "model_window") {
      result = await modelWindowSetup({ input, output, prompts, allowBack: true });
    }
    if (isBackResult(result)) continue;
    return result;
  }
}

async function runChannelSetup({
  input,
  output,
  prompts,
  selection,
  feishuSetup,
  telegramSetup,
  weixinSetup,
}) {
  const channel = await prompts.select({
    message: "通讯渠道",
    showInstructions: false,
    initialValue: selection.channel,
    options: [
      {
        value: "telegram",
        label: "Telegram",
        hint: "Bot 与用户授权",
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
      selection.channel = channel;
      return telegramSetup({ input, output });
    case "feishu":
      selection.channel = channel;
      return feishuSetup({ input, output });
    case "weixin":
      selection.channel = channel;
      return weixinSetup({ input, output });
    default:
      throw new Error(`未知通讯渠道：${String(channel)}`);
  }
}

function isBackResult(result) {
  return result?.action === "back";
}

function emitSetupResult(onResult, category, result, event = "result") {
  if (typeof onResult !== "function") return;
  onResult(sanitizeSetupEvent({
    event,
    ...(category === undefined ? {} : { category }),
    ...(event === "result" ? { result: result === undefined ? null : result } : {}),
  }));
}

function enrichSetupResult(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  if (value.activationResult !== undefined) {
    return value;
  }
  const activation = value.activation;
  if (typeof activation !== "string") return value;
  return {
    ...value,
    activation,
    activationResult: configActivationResult(activation),
  };
}

function isDirectExecution(moduleUrl, argvPath) {
  return Boolean(argvPath) && moduleUrl === pathToFileURL(argvPath).href;
}

function createPromptOutputAdapter(prompts, output) {
  const adapter = { ...prompts };
  for (const method of ["intro", "outro", "cancel", "select", "text", "password", "confirm"]) {
    adapter[method] = (...args) => {
      const first = args[0];
      if (first && typeof first === "object" && !Array.isArray(first)) {
        return prompts[method]({ ...first, output }, ...args.slice(1));
      }
      return prompts[method](...args, { output });
    };
  }
  return adapter;
}

function sanitizeSetupEvent(value, key) {
  if (key === "generatedTokens") return { generated: true };
  if (key === "message" && typeof value === "string") return sanitizeSetupText(value);
  if (Array.isArray(value)) return value.map((entry) => sanitizeSetupEvent(entry));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entryValue]) => [
        entryKey,
        sanitizeSetupEvent(entryValue, entryKey),
      ]),
    );
  }
  return value;
}

function sanitizeSetupText(value) {
  return value
    .replace(/(authorization\s*:\s*(?:bearer|basic)\s+)[^\s'";]+/giu, "$1[REDACTED]")
    .replace(/(\b(?:token|secret|password|passwd|api[_-]?key|access[_-]?key|cookie)\s*[:=]\s*)[^\s'";]+/giu, "$1[REDACTED]")
    .replace(/(\b[A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|ACCESS_KEY|COOKIE)[A-Z0-9_]*\s*=\s*)[^\s;]+/giu, "$1[REDACTED]")
    .slice(0, 320);
}

if (isDirectExecution(import.meta.url, process.argv[1])) {
  const args = process.argv.slice(2);
  const json = args.length === 1 && args[0] === "--jsonl";
  if (args.length > 0 && !json) {
    writeCliMessage("failure", "用法：codexc setup [--jsonl]");
    process.exitCode = 1;
  } else {
    const output = json ? process.stderr : process.stdout;
    const prompts = json
      ? createPromptOutputAdapter(clackPrompts, process.stderr)
      : clackPrompts;
    const onResult = json
      ? (event) => process.stdout.write(`${JSON.stringify(event)}\n`)
      : undefined;
    await runSetup({ stayOnMenu: true, output, prompts, onResult }).catch((error) => {
      if (json) {
        process.stdout.write(`${JSON.stringify(sanitizeSetupEvent({
          event: "error",
          message: error instanceof Error ? error.message : String(error),
        }))}\n`);
      }
      writeCliMessage("failure", error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
  }
}
