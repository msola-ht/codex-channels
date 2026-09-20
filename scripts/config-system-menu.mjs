import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { release as osRelease } from "node:os";
import { join } from "node:path";

import { writeGatewayConfig } from "../runtime/gateway-config.mjs";
import {
  detectTerminalIdentity,
  detectTerminalUserAgentToken,
} from "../runtime/terminal-identity.mjs";
import { writeGatewayConfigActivationNotice } from "./config-activation-notice.mjs";
import {
  loadGatewaySettings,
  updateGatewaySetting,
} from "./config-management.mjs";
import { packageDir } from "./runtime-config.mjs";
import { runTimezoneCommand } from "./timezone-command.mjs";

export async function runSystemSettings({
  environment,
  input,
  output,
  prompts,
  writeConfig = writeGatewayConfig,
  debugSetup,
}) {
  const section = await prompts.select({
    message: "选择系统设置",
    showInstructions: false,
    options: [
      {
        value: "debug",
        label: "调试模式（快捷开关）",
        hint: "在 info / debug 间切换；其他等级在高级设置中选择",
      },
      {
        value: "model_traffic_dump",
        label: "调用详情记录",
        hint: "记录完整模型报文；仅排查时临时开启",
      },
      {
        value: "model_traffic_retention",
        label: "调用记录保留天数",
        hint: "默认 30 天；0 关闭按时间自动清理",
      },
      { value: "approval_timeout", label: "审批超时", hint: "approval.timeout_seconds（30–3600 秒）" },
      {
        value: "idle_release",
        label: "会话空闲自动解除",
        hint: "conversation.idle_release_minutes（默认 15 分钟，0 关闭）",
      },
      {
        value: "sandbox",
        label: "Gateway 渠道 Sandbox",
        hint: "外部渠道默认值；Codex 新会话与用户偏好在 Config 中管理",
      },
      { value: "default_workspace", label: "默认工作区", hint: "default_workspace" },
      {
        value: "default_model",
        label: "渠道新会话模型覆盖",
        hint: "仅覆盖 Gateway 新 Thread；Codex 全局模型与思考等级请用 codexc config",
      },
      {
        value: "official_tui_identity",
        label: "一键设为官方 TUI 身份",
        hint: "同时设置 codex-tui 客户端身份与官方模型上游 UA",
      },
      {
        value: "official_tui_terminal",
        label: "模型上游终端标识",
        hint: "codex.terminal_identity；预填运行本命令的终端，可编辑，留空则删除",
      },
      {
        value: "app_server_timezone",
        label: "模型可见时区",
        hint: "codex.timezone；缺省沿用系统时区，决定模型看到的时区与当前日期，WebUI 同步跟随",
      },
      { value: "back", label: "返回", hint: "返回配置菜单" },
    ],
  });
  if (prompts.isCancel(section) || section === "back") return { action: "back" };
  if (section === "debug") return debugSetup({ environment, input, output, prompts });
  if (section === "model_traffic_dump") {
    return runModelTrafficDump({ environment, output, prompts, writeConfig });
  }
  if (section === "model_traffic_retention") {
    return runModelTrafficRetention({ environment, output, prompts, writeConfig });
  }
  if (section === "approval_timeout") {
    return runApprovalTimeout({ environment, output, prompts, writeConfig });
  }
  if (section === "idle_release") {
    return runIdleRelease({ environment, output, prompts, writeConfig });
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
  if (section === "official_tui_identity") {
    return runOfficialTuiIdentity({ environment, output, prompts, writeConfig });
  }
  if (section === "official_tui_terminal") {
    return runOfficialTuiTerminal({ environment, output, prompts, writeConfig });
  }
  if (section === "app_server_timezone") {
    return runAppServerTimezone({ environment, output, prompts, writeConfig });
  }
  throw new Error(`未知系统设置：${String(section)}`);
}

async function runModelTrafficDump({ environment, output, prompts, writeConfig }) {
  const settings = loadGatewaySettings(environment);
  const selected = await prompts.select({
    message: "调用详情记录（包含完整 prompt、工具输出和代码，仅排查时开启）",
    showInstructions: false,
    initialValue: settings.system.modelTrafficDumpEnabled ? "enabled" : "disabled",
    options: [
      { value: "enabled", label: "开启", hint: "写入用户数据目录下的 traffic/" },
      { value: "disabled", label: "关闭", hint: "停止写入新的调用记录文件" },
      { value: "back", label: "返回上一级" },
    ],
  });
  if (prompts.isCancel(selected) || selected === "back") return { action: "back" };
  if (selected !== "enabled" && selected !== "disabled") {
    throw new Error(`未知调用详情记录设置：${String(selected)}`);
  }
  const enabled = selected === "enabled";
  const result = updateGatewaySetting({
    kind: "system.model-traffic-dump",
    value: enabled,
  }, { environment, expectedRevision: settings.revision, writeConfig });
  output.write(`调用详情记录已${enabled ? "开启" : "关闭"}：${result.configPath}\n`);
  writeGatewayConfigActivationNotice(output, environment, result.activationResult);
  return {
    modelTrafficDumpEnabled: enabled,
    configPath: result.configPath,
    activation: result.activation,
    activationResult: result.activationResult,
  };
}

async function runModelTrafficRetention({ environment, output, prompts, writeConfig }) {
  const settings = loadGatewaySettings(environment);
  const value = await prompts.text({
    message: "调用记录保留天数（0 表示关闭按时间自动清理）",
    initialValue: String(settings.system.modelTrafficRetentionDays),
    validate: (input) => {
      const parsed = Number(input);
      return Number.isInteger(parsed) && parsed >= 0 && parsed <= 36_500
        ? undefined
        : "请输入 0–36500 之间的整数";
    },
  });
  if (prompts.isCancel(value)) return { action: "back" };
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 36_500) {
    throw new Error("调用记录保留天数必须为 0–36500 之间的整数");
  }
  const result = updateGatewaySetting({
    kind: "system.model-traffic-retention-days",
    value: parsed,
  }, { environment, expectedRevision: settings.revision, writeConfig });
  output.write(parsed === 0
    ? `调用详情记录按时间自动清理已关闭：${result.configPath}\n`
    : `调用详情记录已设为保留 ${parsed} 天：${result.configPath}\n`);
  writeGatewayConfigActivationNotice(output, environment, result.activationResult);
  return {
    modelTrafficRetentionDays: parsed,
    configPath: result.configPath,
    activation: result.activation,
    activationResult: result.activationResult,
  };
}

async function runApprovalTimeout({ environment, output, prompts, writeConfig }) {
  const settings = loadGatewaySettings(environment);
  const value = await prompts.text({
    message: "审批超时（秒，30–3600）",
    initialValue: String(settings.system.approvalTimeoutSeconds),
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
  const result = updateGatewaySetting({
    kind: "system.approval-timeout",
    value: parsed,
  }, { environment, expectedRevision: settings.revision, writeConfig });
  output.write(`审批超时已设为 ${parsed} 秒：${result.configPath}\n`);
  writeGatewayConfigActivationNotice(output, environment, result.activationResult);
  return { timeoutSeconds: parsed, configPath: result.configPath, activation: result.activation, activationResult: result.activationResult };
}

async function runIdleRelease({ environment, output, prompts, writeConfig }) {
  const settings = loadGatewaySettings(environment);
  const value = await prompts.text({
    message: "会话空闲自动解除（分钟；0 表示关闭）",
    initialValue: String(settings.system.idleReleaseMinutes),
    validate: (input) => {
      const parsed = Number(input);
      return Number.isInteger(parsed) && parsed >= 0 && parsed <= 1440
        ? undefined
        : "请输入 0–1440 之间的整数";
    },
  });
  if (prompts.isCancel(value)) return { action: "back" };
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 1440) {
    throw new Error("会话空闲自动解除必须为 0–1440 之间的整数");
  }
  const result = updateGatewaySetting({
    kind: "system.idle-release-minutes",
    value: parsed,
  }, { environment, expectedRevision: settings.revision, writeConfig });
  output.write(`会话空闲自动解除已设为 ${parsed} 分钟：${result.configPath}\n`);
  writeGatewayConfigActivationNotice(output, environment, result.activationResult);
  return {
    idleReleaseMinutes: parsed,
    configPath: result.configPath,
    activation: result.activation,
    activationResult: result.activationResult,
  };
}

async function runSandbox({ environment, output, prompts, writeConfig }) {
  const settings = loadGatewaySettings(environment);
  const selected = await prompts.select({
    message: "Gateway 渠道 Sandbox",
    showInstructions: false,
    initialValue: settings.system.sandbox,
    options: [
      { value: "read-only", label: "只读", hint: "禁止工作区写入" },
      { value: "workspace-write", label: "工作区可写", hint: "允许修改授权 Workspace" },
      { value: "back", label: "返回上一级" },
    ],
  });
  if (prompts.isCancel(selected) || selected === "back") return { action: "back" };
  if (selected !== "read-only" && selected !== "workspace-write") {
    throw new Error(`未知 Codex Sandbox 设置：${String(selected)}`);
  }
  const result = updateGatewaySetting({
    kind: "system.sandbox",
    value: selected,
  }, { environment, expectedRevision: settings.revision, writeConfig });
  output.write(`Gateway 渠道 Sandbox 已设为${selected}：${result.configPath}\n`);
  writeGatewayConfigActivationNotice(output, environment, result.activationResult);
  return { sandbox: selected, configPath: result.configPath, activation: result.activation, activationResult: result.activationResult };
}

async function runDefaultWorkspace({ environment, output, prompts, writeConfig }) {
  const settings = loadGatewaySettings(environment);
  const workspaces = settings.system.workspaces;
  if (workspaces.length === 0) {
    output.write("配置中没有已注册的 Workspace；请使用 codexc work add 注册后重试。\n");
    return { action: "back" };
  }
  const selected = await prompts.select({
    message: "默认工作区",
    showInstructions: false,
    initialValue: workspaces.some((entry) => entry.id === settings.system.defaultWorkspace)
      ? settings.system.defaultWorkspace
      : undefined,
    options: [
      ...workspaces.map((workspace) => ({
        value: workspace.id,
        label: workspace.name,
        hint: workspace.id,
      })),
      { value: "back", label: "返回上一级" },
    ],
  });
  if (prompts.isCancel(selected) || selected === "back") return { action: "back" };
  const result = updateGatewaySetting({
    kind: "system.default-workspace",
    value: selected,
  }, { environment, expectedRevision: settings.revision, writeConfig });
  output.write(`默认工作区已设为 ${selected}：${result.configPath}\n`);
  writeGatewayConfigActivationNotice(output, environment, result.activationResult);
  return { defaultWorkspace: selected, configPath: result.configPath, activation: result.activation, activationResult: result.activationResult };
}

async function runDefaultModel({ environment, output, prompts, writeConfig }) {
  const settings = loadGatewaySettings(environment);
  const value = await prompts.text({
    message: "渠道新会话模型覆盖（留空使用 Codex 全局默认）",
    initialValue: settings.system.defaultModel ?? "",
    validate: (input) => input.length <= 256 ? undefined : "模型 ID 过长",
  });
  if (prompts.isCancel(value)) return { action: "back" };
  const normalized = value.trim();
  const result = updateGatewaySetting({
    kind: "system.default-model",
    value: normalized || null,
  }, { environment, expectedRevision: settings.revision, writeConfig });
  output.write(
    normalized
      ? `渠道新会话模型已覆盖为 ${normalized}：${result.configPath}\n`
      : `渠道新会话模型已恢复使用 Codex 全局默认：${result.configPath}\n`,
  );
  writeGatewayConfigActivationNotice(output, environment, result.activationResult);
  return { defaultModel: normalized || null, configPath: result.configPath, activation: result.activation, activationResult: result.activationResult };
}

function buildOfficialCodexUserAgent(codexCliVersion) {
  const name = "codex-tui";
  const osInfo = currentOsInfo();
  const terminal = terminalUserAgentToken();
  return (
    `${name}/${codexCliVersion} (${osInfo.osType} ${osInfo.version}; ${codexArchitecture()}) `
    + `${terminal} (${name}; ${codexCliVersion})`
  );
}

function codexArchitecture() {
  return process.arch === "x64" ? "x86_64" : process.arch;
}

function currentOsInfo() {
  if (process.platform === "darwin") {
    let version = "unknown";
    try {
      const result = spawnSync("sw_vers", ["-productVersion"], { encoding: "utf8" });
      if (result.status === 0 && result.stdout) {
        version = result.stdout.trim() || "unknown";
      }
    } catch {
      // 保持 unknown，交由用户手动修正
    }
    return { osType: "Mac OS", version };
  }
  if (process.platform === "win32") {
    return { osType: "Windows", version: osRelease() };
  }
  return { osType: "Linux", version: osRelease() };
}

function terminalUserAgentToken() {
  return detectTerminalUserAgentToken(process.env) ?? "unknown";
}

async function runOfficialTuiIdentity({ environment, output, prompts, writeConfig }) {
  const settings = loadGatewaySettings(environment);
  const protocolMetadata = JSON.parse(
    readFileSync(join(packageDir, "src", "codex-protocol", "version.json"), "utf8"),
  );
  const codexCliVersion = String(protocolMetadata.codexCli).replace(/^codex-cli\s+/u, "");
  const identity = { name: "codex-tui", version: codexCliVersion };
  const value = await prompts.text({
    message: `官方 TUI 身份：客户端将设为 codex-tui / ${codexCliVersion}；请确认模型上游 User-Agent`
      + "（留空则删除现有 upstream_user_agent，改为透传 App Server 生成的官方 TUI UA）",
    initialValue: buildOfficialCodexUserAgent(codexCliVersion),
    validate: (input) => input.length <= 512 ? undefined : "User-Agent 过长",
  });
  if (prompts.isCancel(value)) return { action: "back" };
  const result = updateGatewaySetting({
    kind: "system.official-tui-identity",
    value: {
      clientIdentity: identity,
      upstreamUserAgent: value === "" ? null : value,
      terminalIdentity: settings.system.officialTuiIdentity.terminalIdentity,
    },
  }, { environment, expectedRevision: settings.revision, writeConfig });
  output.write(
    `已设为官方 TUI 请求身份（codex-tui / ${codexCliVersion}）：${result.configPath}\n`,
  );
  writeGatewayConfigActivationNotice(output, environment, result.activationResult);
  return {
    clientIdentity: result.value.clientIdentity,
    upstreamUserAgent: result.value.upstreamUserAgent,
    configPath: result.configPath,
    activation: result.activation,
    activationResult: result.activationResult,
  };
}

async function runOfficialTuiTerminal({ environment, output, prompts, writeConfig }) {
  const settings = loadGatewaySettings(environment);
  const current = settings.system.officialTuiIdentity;
  const value = await prompts.text({
    message: "模型上游终端标识：默认取运行本命令的终端（如 iTerm.app/3.5.14），可编辑；"
      + "留空则不再设置",
    initialValue: current.terminalIdentity ?? detectTerminalIdentity(process.env) ?? "",
    validate: (input) => input.length <= 64 ? undefined : "终端标识过长",
  });
  if (prompts.isCancel(value)) return { action: "back" };
  const normalized = value.trim();
  const result = updateGatewaySetting({
    kind: "system.official-tui-identity",
    value: {
      clientIdentity: current.clientIdentity,
      upstreamUserAgent: current.upstreamUserAgent,
      terminalIdentity: normalized === "" ? null : normalized,
    },
  }, { environment, expectedRevision: settings.revision, writeConfig });
  output.write(normalized
    ? `模型上游终端标识已设为 ${normalized}：${result.configPath}\n`
    : `已清除模型上游终端标识，模型上游 UA 由 App Server 自行探测终端：${result.configPath}\n`);
  writeGatewayConfigActivationNotice(output, environment, result.activationResult);
  return {
    terminalIdentity: result.value.terminalIdentity,
    configPath: result.configPath,
    activation: result.activation,
    activationResult: result.activationResult,
  };
}

/** 与 `codexc timezone` 共用同一实现，两处入口保持一致的校验与写入路径。 */
async function runAppServerTimezone({ environment, output, prompts, writeConfig }) {
  const result = await runTimezoneCommand([], {
    environment,
    output,
    prompts,
    writeConfig,
  });
  return result.action === "cancelled" ? { action: "back" } : result;
}
