import { spawnSync } from "node:child_process";
import { release as osRelease } from "node:os";

import { officialTuiUserAgentPattern, writeGatewayConfig } from "../runtime/gateway-config.mjs";
import { officialTuiClientVersion } from "../runtime/codex-request-identity.mjs";
import {
  detectTerminalIdentity,
  detectTerminalUserAgentToken,
} from "../runtime/terminal-identity.mjs";
import { writeGatewayConfigActivationNotice } from "./config-activation-notice.mjs";
import {
  loadGatewaySettings,
  updateGatewaySetting,
} from "./config-management.mjs";
import { runTimezoneCommand } from "./timezone-command.mjs";

export async function runSystemSettings({
  environment,
  input,
  output,
  prompts,
  group = "conversation",
  writeConfig = writeGatewayConfig,
}) {
  const groups = {
    conversation: {
      message: "Gateway 会话设置",
      values: ["approval_timeout", "idle_release", "default_workspace", "default_model"],
    },
    identity: {
      message: "身份与时区",
      values: ["official_tui_identity", "official_tui_terminal", "app_server_timezone", "gateway_timezone"],
    },
    traffic: {
      message: "调用记录（Codex 与 Relay 共用）",
      values: ["model_traffic_dump", "model_traffic_mode", "model_traffic_retention"],
    },
  };
  if (!Object.hasOwn(groups, group)) throw new Error(`未知系统设置分组：${String(group)}`);
  const section = await prompts.select({
    message: groups[group].message,
    showInstructions: false,
    options: [
      { value: "approval_timeout", label: "审批超时", hint: "approval.timeout_seconds（30–3600 秒）" },
      {
        value: "idle_release",
        label: "会话空闲自动解除",
        hint: "conversation.idle_release_minutes（默认 15 分钟，0 关闭）",
      },
      { value: "default_workspace", label: "默认工作区", hint: "Gateway 默认项；也可在 codexc work 中设置" },
      {
        value: "default_model",
        label: "渠道新会话模型覆盖",
        hint: "仅覆盖 Gateway 新 Thread；Codex 全局模型与思考等级请用 codexc config",
      },
      {
        value: "official_tui_identity",
        label: "一键设为官方 TUI 身份",
        hint: "同时设置官方身份与 UA，并启用版本自动跟随",
      },
      {
        value: "official_tui_terminal",
        label: "模型上游终端标识",
        hint: "codex.terminal_identity；预填运行本命令的终端，可编辑，留空则删除",
      },
      {
        value: "app_server_timezone",
        label: "服务时区",
        hint: "codex.timezone；缺省沿用系统时区，决定模型看到的时区与当前日期，WebUI 同步跟随",
      },
      {
        value: "gateway_timezone",
        label: "网关时区",
        hint: "默认跟随 App Server，也可选择系统或自定义时区；重启网关后生效",
      },
      {
        value: "model_traffic_dump",
        label: "调用详情记录",
        hint: "Codex 与 Relay 共用；记录完整报文，仅排查时临时开启",
      },
      { value: "model_traffic_mode", label: "调用记录模式", hint: "Codex 与 Relay 共用；生产精简，调试增加报文信息" },
      {
        value: "model_traffic_retention",
        label: "调用记录保留天数",
        hint: "默认 30 天；0 关闭按时间自动清理",
      },
      { value: "back", label: "返回", hint: "返回配置菜单" },
    ].filter((option) => option.value === "back" || groups[group].values.includes(option.value)),
  });
  if (prompts.isCancel(section) || section === "back") return { action: "back" };
  if (!groups[group].values.includes(section)) throw new Error(`未知系统设置：${String(section)}`);
  if (section === "model_traffic_dump") {
    return runModelTrafficDump({ environment, output, prompts, writeConfig });
  }
  if (section === "model_traffic_mode") return runModelTrafficMode({ environment, output, prompts, writeConfig });
  if (section === "model_traffic_retention") {
    return runModelTrafficRetention({ environment, output, prompts, writeConfig });
  }
  if (section === "approval_timeout") {
    return runApprovalTimeout({ environment, output, prompts, writeConfig });
  }
  if (section === "idle_release") {
    return runIdleRelease({ environment, output, prompts, writeConfig });
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
    return runAppServerTimezone({ environment, input, output, prompts, writeConfig });
  }
  if (section === "gateway_timezone") {
    const result = await runTimezoneCommand(["--gateway"], { environment, input, output, prompts, writeConfig });
    return result.action === "cancelled" ? { action: "back" } : result;
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
      return /^\d+$/u.test(String(input).trim()) && Number.isInteger(parsed) && parsed >= 0 && parsed <= 36_500
        ? undefined
        : "请输入 0–36500 之间的整数";
    },
  });
  if (prompts.isCancel(value)) return { action: "back" };
  const parsed = Number(value);
  if (!/^\d+$/u.test(String(value).trim()) || !Number.isInteger(parsed) || parsed < 0 || parsed > 36_500) {
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
      return /^\d+$/u.test(String(input).trim()) && Number.isInteger(parsed) && parsed >= 30 && parsed <= 3600
        ? undefined
        : "请输入 30–3600 之间的整数";
    },
  });
  if (prompts.isCancel(value)) return { action: "back" };
  const parsed = Number(value);
  if (!/^\d+$/u.test(String(value).trim()) || !Number.isInteger(parsed) || parsed < 30 || parsed > 3600) {
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
      return /^\d+$/u.test(String(input).trim()) && Number.isInteger(parsed) && parsed >= 0 && parsed <= 1440
        ? undefined
        : "请输入 0–1440 之间的整数";
    },
  });
  if (prompts.isCancel(value)) return { action: "back" };
  const parsed = Number(value);
  if (!/^\d+$/u.test(String(value).trim()) || !Number.isInteger(parsed) || parsed < 0 || parsed > 1440) {
    throw new Error("会话空闲自动解除必须为 0–1440 之间的整数");
  }
  const result = updateGatewaySetting({
    kind: "system.idle-release-minutes",
    value: parsed,
  }, { environment, expectedRevision: settings.revision, writeConfig });
  output.write(parsed === 0
    ? `会话空闲自动解除已关闭：${result.configPath}\n`
    : `会话空闲自动解除已设为 ${parsed} 分钟：${result.configPath}\n`);
  writeGatewayConfigActivationNotice(output, environment, result.activationResult);
  return {
    idleReleaseMinutes: parsed,
    configPath: result.configPath,
    activation: result.activation,
    activationResult: result.activationResult,
  };
}

export async function runDefaultWorkspace({ environment, output, prompts, writeConfig = writeGatewayConfig }) {
  const settings = loadGatewaySettings(environment);
  const workspaces = settings.system.workspaces;
  if (workspaces.length === 0) {
    output.write("配置中没有已注册的 Workspace；请使用 codexc work add 注册后重试。\n");
    return { action: "back" };
  }
  const back = Symbol("default-workspace-back");
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
      { value: back, label: "返回上一级" },
    ],
  });
  if (prompts.isCancel(selected) || selected === back) return { action: "back" };
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

export async function runOfficialTuiIdentity({ environment, output, prompts, writeConfig = writeGatewayConfig }) {
  const settings = loadGatewaySettings(environment);
  const codexCliVersion = officialTuiClientVersion;
  const identity = { name: "codex-tui", version: codexCliVersion };
  const value = await prompts.text({
    message: `官方 TUI 身份：客户端将设为 codex-tui / ${codexCliVersion}；请确认模型上游 User-Agent`
      + "（将启用 follow_cli_version，后续升级自动更新 Codex 版本，系统和终端信息保留；留空则透传 App Server UA）",
    initialValue: buildOfficialCodexUserAgent(codexCliVersion),
    validate: (input) => input.length > 512 ? "User-Agent 过长"
      : input !== "" && !officialTuiUserAgentPattern.test(input) ? "跟随版本需要两处版本一致的完整官方 TUI UA" : undefined,
  });
  if (prompts.isCancel(value)) return { action: "back" };
  const result = updateGatewaySetting({
    kind: "system.official-tui-identity",
    value: {
      followCliVersion: true,
      clientIdentity: identity,
      upstreamUserAgent: value === "" ? null : value,
      terminalIdentity: settings.system.officialTuiIdentity.terminalIdentity,
    },
  }, { environment, expectedRevision: settings.revision, writeConfig });
  output.write(
    `已设为官方 TUI 请求身份并启用版本跟随（codex-tui / ${codexCliVersion}）：${result.configPath}\n`,
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
      followCliVersion: current.followCliVersion,
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
async function runAppServerTimezone({ environment, input, output, prompts, writeConfig }) {
  const result = await runTimezoneCommand([], {
    input,
    environment,
    output,
    prompts,
    writeConfig,
  });
  return result.action === "cancelled" ? { action: "back" } : result;
}

async function runModelTrafficMode({ environment, output, prompts, writeConfig }) {
  const settings = loadGatewaySettings(environment);
  const value = await prompts.select({ message: "调用记录模式（Codex 与 Relay 共用）", showInstructions: false,
    initialValue: settings.system.modelTrafficMode, options: [
      { value: "production", label: "生产", hint: "精简报文；Codex 使用 3/65536 裁剪参数" },
      { value: "debug", label: "调试", hint: "Codex 使用 0/0；Relay 增加入站与交付阶段，仍脱敏并限制容量" },
      { value: "back", label: "返回上一级" },
    ] });
  if (prompts.isCancel(value) || value === "back") return { action: "back" };
  const result = updateGatewaySetting({ kind: "system.model-traffic-mode", value },
    { environment, expectedRevision: settings.revision, writeConfig });
  output.write(`调用记录模式已保存：${result.configPath}\n`);
  writeGatewayConfigActivationNotice(output, environment, result.activationResult);
  return { modelTrafficMode: value, configPath: result.configPath, activation: result.activation, activationResult: result.activationResult };
}
