import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import * as clackPrompts from "@clack/prompts";

import {
  readGatewayConfig,
  writeGatewayConfig,
} from "../runtime/gateway-config.mjs";
import { runDebugSetup } from "./debug-setup.mjs";
import { requireUserConfig } from "./runtime-config.mjs";

export async function runConfig({
  environment = process.env,
  input = process.stdin,
  output = process.stdout,
  prompts = clackPrompts,
  writeConfig = writeGatewayConfig,
  debugSetup = runDebugSetup,
} = {}) {
  if (!prompts) throw new Error("Config 菜单缺少交互实现");
  const { configPath, dataDir } = resolveConfigPaths(environment);
  if (!output.isTTY) {
    output.write(`用户目录：${dataDir}\n配置文件：${configPath}\n`);
    return { action: "paths", configPath, dataDir };
  }
  prompts.intro("Codex Connect Config");
  while (true) {
    const document = readGatewayConfig(configPath);
    const telegramConfigured = table(document.telegram) !== null;
    const section = await prompts.select({
      message: "选择配置项",
      showInstructions: false,
      options: [
        {
          value: "display",
          label: "显示设置",
          hint: "操作详情、计划更新、参考价人民币换算",
        },
        {
          value: "system",
          label: "系统设置",
          hint: "调试模式、审批超时、Sandbox、默认工作区与模型",
        },
        {
          value: "workspaces",
          label: "工作区设置",
          hint: "沙箱、审批策略与权限 Profile",
        },
        ...(telegramConfigured
          ? [{
              value: "message_format",
              label: "Telegram 消息格式",
              hint: "html 或 rich",
            }]
          : []),
        {
          value: "paths",
          label: "查看配置路径",
          hint: "显示用户目录与配置文件位置",
        },
        {
          value: "cancel",
          label: "取消",
          hint: "退出 Config",
        },
      ],
    });
    if (prompts.isCancel(section) || section === "cancel") {
      prompts.cancel("Config 已取消");
      return undefined;
    }
    switch (section) {
      case "display": {
        const result = await runDisplaySettings({
          environment,
          output,
          prompts,
          writeConfig,
        });
        if (isBackResult(result)) continue;
        return result;
      }
      case "system": {
        const result = await runSystemSettings({
          environment,
          input,
          output,
          prompts,
          writeConfig,
          debugSetup,
        });
        if (isBackResult(result)) continue;
        return result;
      }
      case "workspaces": {
        const result = await runWorkspaceSettings({
          environment,
          output,
          prompts,
          writeConfig,
        });
        if (isBackResult(result)) continue;
        return result;
      }
      case "message_format": {
        const result = await runTelegramMessageFormat({
          environment,
          output,
          prompts,
          writeConfig,
        });
        if (isBackResult(result)) continue;
        return result;
      }
      case "paths":
        output.write(`用户目录：${dataDir}\n配置文件：${configPath}\n`);
        continue;
      default:
        throw new Error(`未知 Config 类别：${String(section)}`);
    }
  }
}

async function runDisplaySettings({
  environment,
  output,
  prompts,
  writeConfig,
}) {
  const section = await prompts.select({
    message: "选择显示设置",
    showInstructions: false,
    options: [
      {
        value: "operation_updates",
        label: "操作详情显示",
        hint: "full / compact / hidden",
      },
      {
        value: "plan_updates",
        label: "计划更新显示",
        hint: "是否显示 Codex 计划",
      },
      {
        value: "price_currency",
        label: "价格显示方式",
        hint: "按提供商选择人民币或美元（DeepSeek 默认人民币）",
      },
      { value: "back", label: "返回", hint: "返回配置菜单" },
    ],
  });
  if (prompts.isCancel(section) || section === "back") {
    return { action: "back" };
  }
  if (section === "operation_updates") {
    return runOperationUpdatesToggle({ environment, output, prompts, writeConfig });
  }
  if (section === "plan_updates") {
    return runPlanUpdatesToggle({ environment, output, prompts, writeConfig });
  }
  if (section === "price_currency") {
    return runPriceCurrency({ environment, output, prompts, writeConfig });
  }
  throw new Error(`未知显示设置：${String(section)}`);
}

async function runSystemSettings({
  environment,
  input,
  output,
  prompts,
  writeConfig,
  debugSetup,
}) {
  const section = await prompts.select({
    message: "选择系统设置",
    showInstructions: false,
    options: [
      {
        value: "debug",
        label: "调试模式",
        hint: "控制全局脱敏调试日志与渠道技术字段",
      },
      {
        value: "approval_timeout",
        label: "审批超时",
        hint: "approval.timeout_seconds（30–3600 秒）",
      },
      {
        value: "sandbox",
        label: "Codex Sandbox",
        hint: "read-only 或 workspace-write",
      },
      {
        value: "default_workspace",
        label: "默认工作区",
        hint: "default_workspace",
      },
      {
        value: "default_model",
        label: "默认模型",
        hint: "codex.default_model（可留空）",
      },
      { value: "back", label: "返回", hint: "返回配置菜单" },
    ],
  });
  if (prompts.isCancel(section) || section === "back") {
    return { action: "back" };
  }
  if (section === "debug") {
    return debugSetup({ environment, input, output, prompts });
  }
  if (section === "approval_timeout") {
    return runApprovalTimeout({ environment, output, prompts, writeConfig });
  }
  if (section === "sandbox") {
    return runSandbox({ environment, output, prompts, writeConfig });
  }
  if (section === "default_workspace") {
    return runDefaultWorkspace({ environment, output, prompts, writeConfig });
  }
  if (section === "default_model") {
    return runDefaultModel({ environment, output, prompts, writeConfig });
  }
  throw new Error(`未知系统设置：${String(section)}`);
}

async function runWorkspaceSettings({
  environment,
  output,
  prompts,
  writeConfig,
}) {
  const { configPath } = requireUserConfig(environment);
  const document = readGatewayConfig(configPath);
  const workspaces = Array.isArray(document.workspaces) ? document.workspaces : [];
  if (workspaces.length === 0) {
    output.write("当前没有已配置的 Workspace。\n");
    return { action: "back" };
  }
  const workspaceEntries = workspaces.map((entry) => table(entry));
  const workspace =
    workspaceEntries.length === 1
      ? String(workspaceEntries[0].id)
      : await prompts.select({
          message: "选择要设置的 Workspace",
          showInstructions: false,
          options: workspaceEntries.map((entry) => ({
            value: String(entry.id),
            label: String(entry.name || entry.id),
            hint: String(entry.id),
          })),
        });
  if (prompts.isCancel(workspace) || workspace === undefined) {
    return { action: "back" };
  }
  const index = workspaceEntries.findIndex(
    (entry) => entry.id === workspace,
  );
  if (index < 0) {
    throw new Error(`未知 Workspace：${String(workspace)}`);
  }
  const entry = workspaceEntries[index];
  while (true) {
    const field = await prompts.select({
      message: `选择 ${entry.name ?? entry.id} 的权限项`,
      showInstructions: false,
      options: [
        {
          value: "sandbox",
          label: "沙箱",
          hint: `当前：${entry.sandbox ?? "未配置（使用全局）"}`,
        },
        {
          value: "approval_policy",
          label: "审批策略",
          hint: `当前：${entry.approval_policy ?? "未配置（使用默认）"}`,
        },
        {
          value: "permissions",
          label: "权限 Profile",
          hint: `当前：${entry.permissions ?? "未配置"}`,
        },
        { value: "back", label: "返回", hint: "返回配置菜单" },
      ],
    });
    if (prompts.isCancel(field) || field === "back") {
      return { action: "back" };
    }
    if (field === "sandbox") {
      const selected = await prompts.select({
        message: "沙箱模式",
        showInstructions: false,
        initialValue: entry.sandbox ?? "workspace-write",
        options: [
          { value: "read-only", label: "只读", hint: "禁止写文件" },
          { value: "workspace-write", label: "工作区可写", hint: "允许修改授权 Workspace" },
          { value: "danger-full-access", label: "完全访问", hint: "不启用文件系统沙箱" },
          { value: "clear", label: "清除（使用全局）", hint: "回退 codex.sandbox" },
        ],
      });
      if (prompts.isCancel(selected) || selected === "clear") {
        if (prompts.isCancel(selected)) continue;
        delete entry.sandbox;
      } else {
        if (selected !== "read-only" && selected !== "workspace-write" && selected !== "danger-full-access") {
          throw new Error(`未知沙箱模式：${String(selected)}`);
        }
        if (entry.permissions !== undefined) {
          output.write("permissions 与 sandbox 互斥，请先清除权限 Profile。\n");
          continue;
        }
        entry.sandbox = selected;
      }
    } else if (field === "approval_policy") {
      const selected = await prompts.select({
        message: "审批策略",
        showInstructions: false,
        initialValue: entry.approval_policy ?? "on-request",
        options: [
          { value: "untrusted", label: "不信任", hint: "更严格地要求审批" },
          { value: "on-request", label: "按需审批", hint: "需要时请求审批" },
          { value: "never", label: "免审批", hint: "不再请求审批" },
          { value: "clear", label: "清除（使用默认）", hint: "回退 on-request" },
        ],
      });
      if (prompts.isCancel(selected) || selected === "clear") {
        if (prompts.isCancel(selected)) continue;
        delete entry.approval_policy;
      } else {
        if (selected !== "untrusted" && selected !== "on-request" && selected !== "never") {
          throw new Error(`未知审批策略：${String(selected)}`);
        }
        entry.approval_policy = selected;
      }
    } else if (field === "permissions") {
      const selected = await prompts.text({
        message: "权限 Profile（留空清除；例如 :read-only、:workspace、:danger-full-access）",
        initialValue: entry.permissions ?? "",
      });
      if (prompts.isCancel(selected)) {
        continue;
      }
      const trimmed = String(selected).trim();
      if (trimmed.length > 0 && entry.sandbox !== undefined) {
        output.write("permissions 与 sandbox 互斥，请先清除沙箱。\n");
        continue;
      }
      if (trimmed.length === 0) {
        delete entry.permissions;
      } else {
        entry.permissions = trimmed;
      }
    } else {
      throw new Error(`未知工作区权限项：${String(field)}`);
    }
    document.workspaces = workspaces;
    writeConfig(configPath, document);
    output.write(
      `已更新 ${entry.name ?? entry.id} 的权限：${configPath}\n`
        + "权限热加载后对新建或恢复的 Thread 生效，不改变已绑定 Thread。\n",
    );
    return {
      workspaceId: String(entry.id),
      sandbox: entry.sandbox,
      approvalPolicy: entry.approval_policy,
      permissions: entry.permissions,
      configPath,
    };
  }
}

async function runOperationUpdatesToggle({
  environment,
  output,
  prompts,
  writeConfig,
}) {
  const { configPath } = requireUserConfig(environment);
  const document = readGatewayConfig(configPath);
  const current = table(document.display).operation_updates;
  const selected = await prompts.select({
    message: "操作详情显示",
    showInstructions: false,
    initialValue: current === "full" || current === "hidden" ? current : "compact",
    options: [
      { value: "full", label: "完整详情", hint: "显示完整操作过程" },
      { value: "compact", label: "单行摘要", hint: "压缩为摘要行" },
      { value: "hidden", label: "隐藏", hint: "不显示操作过程" },
      { value: "back", label: "返回上一级" },
    ],
  });
  if (prompts.isCancel(selected) || selected === "back") {
    return { action: "back" };
  }
  if (selected !== "full" && selected !== "compact" && selected !== "hidden") {
    throw new Error(`未知操作详情显示设置：${String(selected)}`);
  }
  const display = table(document.display);
  display.operation_updates = selected;
  document.display = display;
  writeConfig(configPath, document);
  output.write(`操作详情显示已设为${selected}：${configPath}\n`);
  output.write("配置将在重启 Gateway 后生效；不需要重启 App Server。\n");
  return { operationUpdates: selected, configPath };
}

async function runPlanUpdatesToggle({
  environment,
  output,
  prompts,
  writeConfig,
}) {
  const { configPath } = requireUserConfig(environment);
  const document = readGatewayConfig(configPath);
  const enabled = table(document.display).plan_updates !== false;
  const selected = await prompts.select({
    message: "计划更新显示",
    showInstructions: false,
    initialValue: enabled ? "enabled" : "disabled",
    options: [
      { value: "enabled", label: "开启", hint: "显示 Codex 计划" },
      { value: "disabled", label: "关闭", hint: "隐藏 Codex 计划" },
      { value: "back", label: "返回上一级" },
    ],
  });
  if (prompts.isCancel(selected) || selected === "back") {
    return { action: "back" };
  }
  if (selected !== "enabled" && selected !== "disabled") {
    throw new Error(`未知计划更新显示设置：${String(selected)}`);
  }
  const display = table(document.display);
  display.plan_updates = selected === "enabled";
  document.display = display;
  writeConfig(configPath, document);
  output.write(`计划更新显示已${selected === "enabled" ? "开启" : "关闭"}：${configPath}\n`);
  output.write("配置将在重启 Gateway 后生效；不需要重启 App Server。\n");
  return { planUpdatesEnabled: selected === "enabled", configPath };
}

async function runPriceCurrency({
  environment,
  output,
  prompts,
  writeConfig,
}) {
  const { configPath } = requireUserConfig(environment);
  const document = readGatewayConfig(configPath);
  const display = table(document.display);
  const scope = await prompts.select({
    message: "价格显示方式 · 选择提供商",
    showInstructions: false,
    options: [
      {
        value: "global",
        label: "全局默认",
        hint: "跟随提供商：DeepSeek 人民币、OpenAI 官方美元",
      },
      {
        value: "deepseek",
        label: "DeepSeek 官方",
        hint: "覆盖 DeepSeek 提供商的价格显示",
      },
      {
        value: "openai",
        label: "OpenAI 官方",
        hint: "覆盖 OpenAI 官方提供商的价格显示",
      },
      { value: "back", label: "返回上一级" },
    ],
  });
  if (prompts.isCancel(scope) || scope === "back") {
    return { action: "back" };
  }
  if (scope !== "global" && scope !== "deepseek" && scope !== "openai") {
    throw new Error(`未知价格显示提供商：${String(scope)}`);
  }
  const current = scope === "global"
    ? display.price_currency
    : table(display.price_currency_by_provider)[scope];
  const mode = await prompts.select({
    message: "价格显示方式 · 选择币种",
    showInstructions: false,
    initialValue: current === "cny" || current === "usd" ? current : "auto",
    options: [
      {
        value: "auto",
        label: "跟随提供商默认",
        hint: "DeepSeek 人民币、OpenAI 官方美元、其他美元",
      },
      {
        value: "cny",
        label: "人民币",
        hint: "统一按人民币显示（需要汇率）",
      },
      {
        value: "usd",
        label: "美元",
        hint: "统一按美元显示",
      },
      { value: "back", label: "返回上一级" },
    ],
  });
  if (prompts.isCancel(mode) || mode === "back") {
    return { action: "back" };
  }
  if (mode !== "auto" && mode !== "cny" && mode !== "usd") {
    throw new Error(`未知价格显示方式：${String(mode)}`);
  }
  if (scope === "global") {
    display.price_currency = mode;
  } else {
    const overrides = table(display.price_currency_by_provider);
    overrides[scope] = mode;
    display.price_currency_by_provider = overrides;
  }
  document.display = display;
  writeConfig(configPath, document);
  output.write(
    scope === "global"
      ? `全局价格显示方式已设为 ${mode}：${configPath}\n`
      : `${scope} 价格显示方式已设为 ${mode}：${configPath}\n`,
  );
  output.write("配置将在重启 Gateway 后生效；不需要重启 App Server。\n");
  return { scope, mode, configPath };
}

async function runApprovalTimeout({
  environment,
  output,
  prompts,
  writeConfig,
}) {
  const { configPath } = requireUserConfig(environment);
  const document = readGatewayConfig(configPath);
  const current = Number(table(document.approval).timeout_seconds) || 300;
  const value = await prompts.text({
    message: "审批超时（秒，30–3600）",
    initialValue: String(current),
    validate: (input) => {
      const parsed = Number(input);
      return Number.isInteger(parsed) && parsed >= 30 && parsed <= 3600
        ? undefined
        : "请输入 30–3600 之间的整数";
    },
  });
  if (prompts.isCancel(value)) return { action: "back" };
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 30 || parsed > 3600) {
    throw new Error("审批超时必须为 30–3600 之间的整数");
  }
  document.approval = { ...table(document.approval), timeout_seconds: parsed };
  writeConfig(configPath, document);
  output.write(`审批超时已设为 ${parsed} 秒：${configPath}\n`);
  output.write("配置将在重启 Gateway 后生效；不需要重启 App Server。\n");
  return { timeoutSeconds: parsed, configPath };
}

async function runSandbox({
  environment,
  output,
  prompts,
  writeConfig,
}) {
  const { configPath } = requireUserConfig(environment);
  const document = readGatewayConfig(configPath);
  const current = table(document.codex).sandbox;
  const selected = await prompts.select({
    message: "Codex Sandbox",
    showInstructions: false,
    initialValue: current === "read-only" ? "read-only" : "workspace-write",
    options: [
      { value: "read-only", label: "只读", hint: "禁止工作区写入" },
      { value: "workspace-write", label: "工作区可写", hint: "允许修改授权 Workspace" },
      { value: "back", label: "返回上一级" },
    ],
  });
  if (prompts.isCancel(selected) || selected === "back") {
    return { action: "back" };
  }
  if (selected !== "read-only" && selected !== "workspace-write") {
    throw new Error(`未知 Codex Sandbox 设置：${String(selected)}`);
  }
  const codex = table(document.codex);
  codex.sandbox = selected;
  document.codex = codex;
  writeConfig(configPath, document);
  output.write(`Codex Sandbox 已设为${selected}：${configPath}\n`);
  output.write("配置将在重启 Gateway 后生效；不需要重启 App Server。\n");
  return { sandbox: selected, configPath };
}

async function runDefaultWorkspace({
  environment,
  output,
  prompts,
  writeConfig,
}) {
  const { configPath } = requireUserConfig(environment);
  const document = readGatewayConfig(configPath);
  const workspaces = Array.isArray(document.workspaces) ? document.workspaces : [];
  if (workspaces.length === 0) {
    output.write("配置中没有已注册的 Workspace；请使用 codexc work add 注册后重试。\n");
    return { action: "back" };
  }
  const current = typeof document.default_workspace === "string"
    ? document.default_workspace
    : undefined;
  const selected = await prompts.select({
    message: "默认工作区",
    showInstructions: false,
    initialValue: workspaces.some((entry) => table(entry).id === current)
      ? current
      : undefined,
    options: [
      ...workspaces.map((entry) => {
        const workspace = table(entry);
        return {
          value: String(workspace.id),
          label: String(workspace.name || workspace.id),
          hint: String(workspace.id),
        };
      }),
      { value: "back", label: "返回上一级" },
    ],
  });
  if (prompts.isCancel(selected) || selected === "back") {
    return { action: "back" };
  }
  document.default_workspace = selected;
  writeConfig(configPath, document);
  output.write(`默认工作区已设为 ${selected}：${configPath}\n`);
  output.write("配置将在重启 Gateway 后生效；不需要重启 App Server。\n");
  return { defaultWorkspace: selected, configPath };
}

async function runDefaultModel({
  environment,
  output,
  prompts,
  writeConfig,
}) {
  const { configPath } = requireUserConfig(environment);
  const document = readGatewayConfig(configPath);
  const current = table(document.codex).default_model;
  const value = await prompts.text({
    message: "默认模型（留空恢复模型默认）",
    initialValue: typeof current === "string" ? current : "",
    validate: (input) => input.length <= 256 ? undefined : "模型 ID 过长",
  });
  if (prompts.isCancel(value)) return { action: "back" };
  const codex = table(document.codex);
  const normalized = value.trim();
  if (normalized) {
    codex.default_model = normalized;
  } else {
    delete codex.default_model;
  }
  document.codex = codex;
  writeConfig(configPath, document);
  output.write(
    normalized
      ? `默认模型已设为 ${normalized}：${configPath}\n`
      : `默认模型已恢复为模型默认：${configPath}\n`,
  );
  output.write("配置将在重启 Gateway 后生效；不需要重启 App Server。\n");
  return { defaultModel: normalized || null, configPath };
}

async function runTelegramMessageFormat({
  environment,
  output,
  prompts,
  writeConfig,
}) {
  const { configPath } = requireUserConfig(environment);
  const document = readGatewayConfig(configPath);
  const current = table(document.telegram).message_format;
  const selected = await prompts.select({
    message: "Telegram 消息格式",
    showInstructions: false,
    initialValue: current === "rich" ? "rich" : "html",
    options: [
      { value: "html", label: "HTML", hint: "使用 HTML 格式" },
      { value: "rich", label: "富文本", hint: "使用富文本消息" },
      { value: "back", label: "返回上一级" },
    ],
  });
  if (prompts.isCancel(selected) || selected === "back") {
    return { action: "back" };
  }
  if (selected !== "html" && selected !== "rich") {
    throw new Error(`未知 Telegram 消息格式：${String(selected)}`);
  }
  const telegram = table(document.telegram);
  telegram.message_format = selected;
  document.telegram = telegram;
  writeConfig(configPath, document);
  output.write(`Telegram 消息格式已设为 ${selected}：${configPath}\n`);
  output.write("配置将在重启 Gateway 后生效；不需要重启 App Server。\n");
  return { messageFormat: selected, configPath };
}

function resolveConfigPaths(environment) {
  const explicit = environment.CODEX_CONNECT_CONFIG_FILE?.trim();
  if (explicit) {
    return { configPath: explicit, dataDir: dirname(explicit) };
  }
  const home = environment.CODEX_CONNECT_HOME?.trim()
    || join(homedir(), ".codex-connect");
  return { configPath: join(home, "config.toml"), dataDir: home };
}

function isBackResult(value) {
  return value !== null
    && typeof value === "object"
    && value.action === "back";
}

function table(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

if (
  process.argv[1]
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  runConfig().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
