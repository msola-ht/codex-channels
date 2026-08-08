import { homedir } from "node:os";
import { chmodSync, copyFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import * as clackPrompts from "@clack/prompts";

import {
  isPrivateHttpEndpoint,
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
        {
          value: "webui",
          label: "WebUI 设置",
          hint: "监听地址、端口与访问令牌",
        },
        {
          value: "metrics",
          label: "多设备指标",
          hint: "本机接入中心与全局视图",
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
      case "webui": {
        const result = await runWebuiSettings({
          environment,
          output,
          prompts,
          writeConfig,
        });
        if (isBackResult(result)) continue;
        return result;
      }
      case "metrics": {
        const result = await runMetricsSettings({
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

const deviceIdPattern = /^[a-z0-9][a-z0-9_-]{0,63}$/u;

async function runMetricsSettings({
  environment,
  output,
  prompts,
  writeConfig,
}) {
  while (true) {
    const section = await prompts.select({
      message: "选择多设备指标设置",
      showInstructions: false,
      options: [
        {
          value: "connect",
          label: "本机接入中心",
          hint: "配置指标上报与 WebUI 全局视图",
        },
        {
          value: "status",
          label: "查看接入状态",
          hint: "显示上报与全局视图的当前配置",
        },
        {
          value: "sync_params",
          label: "上报参数",
          hint: "上报间隔与单批条数上限",
        },
        {
          value: "disable",
          label: "停用接入",
          hint: "停用上报与全局视图（配置保留）",
        },
        { value: "back", label: "返回", hint: "返回配置菜单" },
      ],
    });
    if (prompts.isCancel(section) || section === "back") {
      return { action: "back" };
    }
    if (section === "connect") {
      const result = await runConnectToCenter({
        environment,
        output,
        prompts,
        writeConfig,
      });
      if (isBackResult(result)) continue;
      return result;
    }
    if (section === "status") {
      await runMetricsStatus({ environment, output });
      continue;
    }
    if (section === "sync_params") {
      const result = await runSyncParams({
        environment,
        output,
        prompts,
        writeConfig,
      });
      if (isBackResult(result)) continue;
      return result;
    }
    if (section === "disable") {
      const result = await runDisableConnection({
        environment,
        output,
        writeConfig,
      });
      if (isBackResult(result)) continue;
      return result;
    }
    throw new Error(`未知多设备指标设置：${String(section)}`);
  }
}

async function runConnectToCenter({
  environment,
  output,
  prompts,
  writeConfig,
}) {
  const { configPath } = requireUserConfig(environment);
  const endpoint = await prompts.text({
    message: "中心地址（例如 https://center.example.com 或 http://127.0.0.1:8790）",
    validate: (input) => {
      try {
        normalizeEndpoint(String(input).trim());
        return undefined;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    },
  });
  if (prompts.isCancel(endpoint)) return { action: "back" };
  const base = normalizeEndpoint(String(endpoint).trim());
  const deviceToken = await prompts.password({
    message: "设备上报令牌",
  });
  if (prompts.isCancel(deviceToken)) return { action: "back" };
  const normalizedDeviceToken = String(deviceToken).trim();
  if (normalizedDeviceToken.length === 0) {
    output.write("设备上报令牌不能为空。\n");
    return { action: "back" };
  }
  const viewToken = await prompts.password({
    message: "全局查看令牌（必须与设备上报令牌不同）",
  });
  if (prompts.isCancel(viewToken)) return { action: "back" };
  const normalizedViewToken = String(viewToken).trim();
  if (normalizedViewToken.length === 0) {
    output.write("全局查看令牌不能为空。\n");
    return { action: "back" };
  }
  if (normalizedViewToken === normalizedDeviceToken) {
    output.write("设备上报令牌与全局查看令牌必须不同。\n");
    return { action: "back" };
  }
  const deviceId = await prompts.text({
    message: "设备 ID（可留空自动生成）",
    initialValue: "",
  });
  if (prompts.isCancel(deviceId)) return { action: "back" };
  const normalizedDeviceId = String(deviceId).trim();
  if (normalizedDeviceId.length > 0 && !deviceIdPattern.test(normalizedDeviceId)) {
    output.write(
      "设备 ID 必须以小写字母或数字开头，只能包含小写字母、数字、- 和 _，最长 64 位。\n",
    );
    return { action: "back" };
  }

  const document = readGatewayConfig(configPath);
  backupConfig(configPath);
  const metrics = table(document.metrics);
  const sync = table(metrics.sync);
  sync.enabled = true;
  sync.endpoint = `${base}/api/ingest`;
  sync.device_token = normalizedDeviceToken;
  if (normalizedDeviceId.length > 0) {
    sync.device_id = normalizedDeviceId;
  }
  metrics.sync = sync;
  metrics.view = {
    enabled: true,
    endpoint: base,
    token: normalizedViewToken,
  };
  document.metrics = metrics;
  writeConfig(configPath, document);
  output.write(`已接入中心：${base}\n`);
  output.write(`设备 ID：${normalizedDeviceId || sync.device_id || "自动生成"}\n`);
  output.write("配置已写入并备份，重启 Gateway 后开始上报，重启 WebUI 后全局页生效。\n");
  return { endpoint: base, deviceId: normalizedDeviceId || null, configPath };
}

async function runMetricsStatus({ environment, output }) {
  const { configPath } = requireUserConfig(environment);
  const document = readGatewayConfig(configPath);
  const metrics = table(document.metrics);
  const sync = table(metrics.sync);
  const view = metrics.view;
  output.write(`上报：${sync.enabled === true ? "已启用" : "已停用"}\n`);
  output.write(`上报端点：${sync.endpoint ?? "未配置"}\n`);
  output.write(`设备 ID：${sync.device_id ?? "自动生成"}\n`);
  output.write(`上报间隔：${sync.interval_seconds ?? 60} 秒\n`);
  output.write(`单批上限：${sync.batch_size ?? 200} 条\n`);
  output.write(`WebUI 全局视图：${view?.enabled === true ? "已启用" : "已停用"}\n`);
  output.write(`查看端点：${view?.endpoint ?? "未配置"}\n`);
  output.write(`设备上报令牌：${maskToken(sync.device_token)}\n`);
  output.write(`全局查看令牌：${maskToken(view?.token)}\n`);
  return { action: "back" };
}

async function runSyncParams({
  environment,
  output,
  prompts,
  writeConfig,
}) {
  const { configPath } = requireUserConfig(environment);
  while (true) {
    const document = readGatewayConfig(configPath);
    const sync = table(table(document.metrics).sync);
    const section = await prompts.select({
      message: "选择上报参数",
      showInstructions: false,
      options: [
        {
          value: "interval_seconds",
          label: "上报间隔",
          hint: `当前：${sync.interval_seconds ?? 60} 秒（10–86400）`,
        },
        {
          value: "batch_size",
          label: "单批上限",
          hint: `当前：${sync.batch_size ?? 200} 条（1–500）`,
        },
        { value: "back", label: "返回", hint: "返回多设备指标菜单" },
      ],
    });
    if (prompts.isCancel(section) || section === "back") {
      return { action: "back" };
    }
    if (section === "interval_seconds") {
      const value = await prompts.text({
        message: "上报间隔（秒，10–86400，默认 60）",
        initialValue: String(sync.interval_seconds ?? 60),
        validate: (input) => {
          const parsed = Number(input);
          return Number.isInteger(parsed) && parsed >= 10 && parsed <= 86400
            ? undefined
            : "请输入 10–86400 之间的整数";
        },
      });
      if (prompts.isCancel(value)) continue;
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 10 || parsed > 86400) {
        output.write("上报间隔必须是 10–86400 之间的整数。\n");
        continue;
      }
      sync.interval_seconds = parsed;
    } else if (section === "batch_size") {
      const value = await prompts.text({
        message: "单批条数上限（1–500，默认 200）",
        initialValue: String(sync.batch_size ?? 200),
        validate: (input) => {
          const parsed = Number(input);
          return Number.isInteger(parsed) && parsed >= 1 && parsed <= 500
            ? undefined
            : "请输入 1–500 之间的整数";
        },
      });
      if (prompts.isCancel(value)) continue;
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 500) {
        output.write("单批条数上限必须是 1–500 之间的整数。\n");
        continue;
      }
      sync.batch_size = parsed;
    } else {
      throw new Error(`未知上报参数：${String(section)}`);
    }
    const metrics = table(document.metrics);
    metrics.sync = sync;
    document.metrics = metrics;
    writeConfig(configPath, document);
    output.write(`上报参数已更新：${configPath}\n`);
    output.write("配置在重启 Gateway 后生效。\n");
    return { sync, configPath };
  }
}

async function runDisableConnection({ environment, output, writeConfig }) {
  const { configPath } = requireUserConfig(environment);
  const document = readGatewayConfig(configPath);
  backupConfig(configPath);
  const metrics = table(document.metrics);
  const sync = table(metrics.sync);
  sync.enabled = false;
  metrics.sync = sync;
  if (metrics.view !== undefined) {
    metrics.view.enabled = false;
  }
  document.metrics = metrics;
  writeConfig(configPath, document);
  output.write("已停用中心接入（配置保留，可在「多设备指标」中重新配置）。\n");
  output.write("重启 Gateway 与 WebUI 后生效。\n");
  return { disabled: true, configPath };
}

export async function runCenterSettings({
  environment,
  output,
  prompts,
  writeConfig,
}) {
  const { configPath } = requireUserConfig(environment);
  while (true) {
    const document = readGatewayConfig(configPath);
    const center = { ...table(table(document.metrics).center) };
    const section = await prompts.select({
      message: "选择中心服务设置",
      showInstructions: false,
      options: [
        {
          value: "enabled",
          label: "启用状态",
          hint: `当前：${center.enabled === true ? "已启用" : "已停用"}`,
        },
        {
          value: "host",
          label: "监听地址",
          hint: `当前：${center.host ?? "127.0.0.1（默认）"}`,
        },
        {
          value: "port",
          label: "监听端口",
          hint: `当前：${center.port ?? "8790（默认）"}`,
        },
        {
          value: "token",
          label: "查看令牌",
          hint: center.token === undefined
            ? "未设置；绑定 0.0.0.0 时必须设置"
            : "已设置（内容不显示）",
        },
        {
          value: "device_token",
          label: "设备上报令牌",
          hint: center.device_token === undefined
            ? "未设置；绑定 0.0.0.0 时必须设置"
            : "已设置（内容不显示）",
        },
        {
          value: "database_path",
          label: "数据库路径",
          hint: `当前：${center.database_path ?? "data/central-metrics.sqlite3（默认）"}`,
        },
        { value: "back", label: "返回", hint: "返回多设备指标菜单" },
      ],
    });
    if (prompts.isCancel(section) || section === "back") {
      return { action: "back" };
    }
    if (section === "enabled") {
      const selected = await prompts.select({
        message: "中心服务启用状态",
        showInstructions: false,
        initialValue: center.enabled === true ? "enabled" : "disabled",
        options: [
          { value: "enabled", label: "启用", hint: "启动 codexc center 后接收设备上报" },
          { value: "disabled", label: "停用", hint: "停止接收上报" },
          { value: "back", label: "返回上一级" },
        ],
      });
      if (prompts.isCancel(selected) || selected === "back") continue;
      if (selected !== "enabled" && selected !== "disabled") {
        throw new Error(`未知中心服务状态：${String(selected)}`);
      }
      center.enabled = selected === "enabled";
    } else if (section === "host") {
      const selected = await prompts.select({
        message: "监听地址",
        showInstructions: false,
        initialValue: center.host ?? "127.0.0.1",
        options: [
          { value: "127.0.0.1", label: "仅本机", hint: "默认，仅本机 WebUI 可用" },
          { value: "::1", label: "仅本机（IPv6 回环）", hint: "IPv6 环境使用" },
          { value: "0.0.0.0", label: "所有网卡", hint: "其他设备接入，必须设置令牌" },
          { value: "clear", label: "恢复默认", hint: "回到仅本机" },
        ],
      });
      if (prompts.isCancel(selected)) continue;
      if (selected === "clear") {
        delete center.host;
      } else {
        if (!["127.0.0.1", "::1", "0.0.0.0"].includes(selected)) {
          throw new Error(`未知监听地址：${String(selected)}`);
        }
        center.host = selected;
      }
      if (center.host === "0.0.0.0") {
        let missingToken = false;
        for (const [field, label] of [
          ["token", "查看令牌"],
          ["device_token", "设备上报令牌"],
        ]) {
          if (center[field] !== undefined) continue;
          const token = await prompts.password({
            message: `绑定 0.0.0.0 必须设置${label}（留空取消）`,
          });
          if (prompts.isCancel(token) || String(token).trim() === "") {
            output.write(`未设置${label}，监听地址未修改。\n`);
            missingToken = true;
            break;
          }
          center[field] = String(token).trim();
        }
        if (missingToken) continue;
      }
    } else if (section === "port") {
      const value = await prompts.text({
        message: "监听端口（1–65535，默认 8790）",
        initialValue: String(center.port ?? 8790),
      });
      if (prompts.isCancel(value)) continue;
      const port = Number(String(value).trim());
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        output.write("端口必须是 1 到 65535 的整数。\n");
        continue;
      }
      center.port = port;
    } else if (section === "token" || section === "device_token") {
      const tokenField = section;
      const tokenLabel = tokenField === "token" ? "查看令牌" : "设备上报令牌";
      const action = await prompts.select({
        message: tokenLabel,
        showInstructions: false,
        options: [
          {
            value: "set",
            label: center[tokenField] === undefined ? "设置令牌" : "重新设置令牌",
            hint: center[tokenField] === undefined
              ? "绑定 0.0.0.0 时必须设置"
              : "替换现有令牌",
          },
          ...(center[tokenField] === undefined
            ? []
            : [{ value: "clear", label: "清除令牌", hint: "清除后不能再绑定 0.0.0.0" }]),
          { value: "back", label: "返回上一级" },
        ],
      });
      if (prompts.isCancel(action) || action === "back") continue;
      if (action === "clear") {
        if (center.host === "0.0.0.0") {
          output.write("绑定 0.0.0.0 时必须保留访问令牌，请先改回仅本机。\n");
          continue;
        }
        delete center[tokenField];
      } else if (action === "set") {
        const token = await prompts.password({
          message: `输入${tokenLabel}（留空取消）`,
        });
        if (prompts.isCancel(token) || String(token).trim() === "") continue;
        center[tokenField] = String(token).trim();
      } else {
        throw new Error(`未知${tokenLabel}操作：${String(action)}`);
      }
    } else if (section === "database_path") {
      const value = await prompts.text({
        message: "中心 SQLite 路径（相对配置目录或绝对路径）",
        initialValue: center.database_path ?? "data/central-metrics.sqlite3",
      });
      if (prompts.isCancel(value)) continue;
      const path = String(value).trim();
      if (path.length === 0) {
        output.write("数据库路径不能为空。\n");
        continue;
      }
      center.database_path = path;
    } else {
      throw new Error(`未知中心服务设置：${String(section)}`);
    }
    if (
      center.token !== undefined
      && center.device_token !== undefined
      && center.token === center.device_token
    ) {
      output.write("查看令牌与设备上报令牌必须不同。\n");
      continue;
    }
    const metrics = table(document.metrics);
    metrics.center = center;
    document.metrics = metrics;
    writeConfig(configPath, document);
    output.write(`中心服务设置已更新：${configPath}\n`);
    output.write("配置在重启 codexc center 后生效。\n");
    return { center, configPath };
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
        hint: "全局统一人民币或美元",
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

async function runWebuiSettings({
  environment,
  output,
  prompts,
  writeConfig,
}) {
  const { configPath } = requireUserConfig(environment);
  while (true) {
    const document = readGatewayConfig(configPath);
    const webui = { ...table(document.webui) };
    const section = await prompts.select({
      message: "选择 WebUI 设置",
      showInstructions: false,
      options: [
        {
          value: "host",
          label: "监听地址",
          hint: `当前：${webui.host ?? "127.0.0.1（默认）"}`,
        },
        {
          value: "port",
          label: "监听端口",
          hint: `当前：${webui.port ?? "8787（默认）"}`,
        },
        {
          value: "token",
          label: "访问令牌",
          hint: webui.token === undefined
            ? "未设置；绑定 0.0.0.0 时必须设置"
            : "已设置（内容不显示）",
        },
        { value: "back", label: "返回", hint: "返回配置菜单" },
      ],
    });
    if (prompts.isCancel(section) || section === "back") {
      return { action: "back" };
    }
    if (section === "host") {
      const selected = await prompts.select({
        message: "监听地址",
        showInstructions: false,
        initialValue: webui.host ?? "127.0.0.1",
        options: [
          { value: "127.0.0.1", label: "仅本机", hint: "默认，最安全" },
          { value: "::1", label: "仅本机（IPv6 回环）", hint: "IPv6 环境使用" },
          { value: "0.0.0.0", label: "所有网卡", hint: "局域网/公网直连，必须设置令牌" },
          { value: "clear", label: "恢复默认", hint: "回到仅本机" },
        ],
      });
      if (prompts.isCancel(selected)) continue;
      if (selected === "clear") {
        delete webui.host;
      } else {
        if (!["127.0.0.1", "::1", "0.0.0.0"].includes(selected)) {
          throw new Error(`未知监听地址：${String(selected)}`);
        }
        webui.host = selected;
      }
      if (webui.host === "0.0.0.0" && webui.token === undefined) {
        const token = await prompts.password({
          message: "绑定 0.0.0.0 必须设置访问令牌（留空取消）",
        });
        if (prompts.isCancel(token) || String(token).trim() === "") {
          output.write("未设置访问令牌，监听地址未修改。\n");
          continue;
        }
        webui.token = String(token).trim();
      }
    } else if (section === "port") {
      const value = await prompts.text({
        message: "监听端口（1–65535，默认 8787）",
        initialValue: String(webui.port ?? 8787),
      });
      if (prompts.isCancel(value)) continue;
      const port = Number(String(value).trim());
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        output.write("端口必须是 1 到 65535 的整数。\n");
        continue;
      }
      webui.port = port;
    } else if (section === "token") {
      const action = await prompts.select({
        message: "访问令牌",
        showInstructions: false,
        options: [
          {
            value: "set",
            label: webui.token === undefined ? "设置令牌" : "重新设置令牌",
            hint: webui.token === undefined
              ? "绑定 0.0.0.0 时必须设置"
              : "替换现有令牌",
          },
          ...(webui.token === undefined
            ? []
            : [{ value: "clear", label: "清除令牌", hint: "清除后不能再绑定 0.0.0.0" }]),
          { value: "back", label: "返回上一级" },
        ],
      });
      if (prompts.isCancel(action) || action === "back") continue;
      if (action === "clear") {
        if (webui.host === "0.0.0.0") {
          output.write("绑定 0.0.0.0 时必须保留访问令牌，请先改回仅本机。\n");
          continue;
        }
        delete webui.token;
      } else if (action === "set") {
        const token = await prompts.password({
          message: "输入访问令牌（留空取消）",
        });
        if (prompts.isCancel(token) || String(token).trim() === "") continue;
        webui.token = String(token).trim();
      } else {
        throw new Error(`未知访问令牌操作：${String(action)}`);
      }
    } else {
      throw new Error(`未知 WebUI 设置：${String(section)}`);
    }
    document.webui = webui;
    writeConfig(configPath, document);
    output.write(`WebUI 设置已更新：${configPath}\n`);
    output.write("配置将在重启 codexc webui 后生效；CLI 参数优先于本配置。\n");
    return { webui: document.webui, configPath };
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
  const mode = await prompts.select({
    message: "全局价格显示方式",
    showInstructions: false,
    initialValue: display.price_currency === "usd" ? "usd" : "cny",
    options: [
      {
        value: "cny",
        label: "人民币",
        hint: "全局统一人民币（需要汇率缓存）",
      },
      {
        value: "usd",
        label: "美元",
        hint: "全局统一美元",
      },
      { value: "back", label: "返回上一级" },
    ],
  });
  if (prompts.isCancel(mode) || mode === "back") {
    return { action: "back" };
  }
  if (mode !== "cny" && mode !== "usd") {
    throw new Error(`未知价格显示方式：${String(mode)}`);
  }
  display.price_currency = mode;
  delete display.price_currency_by_provider;
  document.display = display;
  writeConfig(configPath, document);
  output.write(`全局价格显示方式已设为 ${mode}：${configPath}\n`);
  output.write("配置将在重启 Gateway 后生效；不需要重启 App Server。\n");
  return { priceCurrency: mode, configPath };
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

function normalizeEndpoint(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`中心地址无效：${value}`);
  }
  if (url.protocol !== "https:" && !isPrivateHttpEndpoint(url)) {
    throw new Error("中心地址必须使用 HTTPS，或指向回环/私网地址的 HTTP");
  }
  return url.toString().replace(/\/+$/u, "");
}

function maskToken(token) {
  if (typeof token !== "string" || token.length === 0) return "未配置";
  if (token.length <= 8) return "****";
  return `${token.slice(0, 4)}****${token.slice(-4)}`;
}

function backupConfig(configPath) {
  const backupPath = `${configPath}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  copyFileSync(configPath, backupPath);
  chmodSync(backupPath, 0o600);
  return backupPath;
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
