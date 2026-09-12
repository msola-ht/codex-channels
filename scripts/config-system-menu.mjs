import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { release as osRelease } from "node:os";
import { join } from "node:path";

import { writeGatewayConfig } from "../runtime/gateway-config.mjs";
import { writeGatewayConfigActivationNotice } from "./config-activation-notice.mjs";
import {
  loadGatewaySettings,
  updateGatewaySetting,
} from "./config-management.mjs";
import { packageDir } from "./runtime-config.mjs";

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
      { value: "approval_timeout", label: "审批超时", hint: "approval.timeout_seconds（30–3600 秒）" },
      {
        value: "idle_release",
        label: "会话空闲自动解除",
        hint: "conversation.idle_release_minutes（默认 15 分钟，0 关闭）",
      },
      {
        value: "sandbox",
        label: "Gateway 渠道 Sandbox",
        hint: "外部渠道默认值；Codex 新会话默认值在 Setup 中管理",
      },
      { value: "default_workspace", label: "默认工作区", hint: "default_workspace" },
      {
        value: "default_model",
        label: "渠道新会话模型覆盖",
        hint: "仅覆盖 Gateway 新 Thread；Codex 全局模型与思考等级请用 codexc setup",
      },
      {
        value: "official_tui_identity",
        label: "一键设为官方 TUI 身份",
        hint: "同时设置 codex-tui 客户端身份与官方模型上游 UA",
      },
      { value: "back", label: "返回", hint: "返回配置菜单" },
    ],
  });
  if (prompts.isCancel(section) || section === "back") return { action: "back" };
  if (section === "debug") return debugSetup({ environment, input, output, prompts });
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
  throw new Error(`未知系统设置：${String(section)}`);
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
  const program = process.env.TERM_PROGRAM;
  const version = process.env.TERM_PROGRAM_VERSION;
  if (program && program.trim()) {
    return sanitizeUserAgentToken(version && version.trim()
      ? `${program.trim()}/${version.trim()}`
      : program.trim());
  }
  const term = process.env.TERM;
  return sanitizeUserAgentToken(term && term.trim() ? term.trim() : "unknown");
}

function sanitizeUserAgentToken(value) {
  return value.replace(/[^A-Za-z0-9._/-]/gu, "_");
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
      + "（留空则删除现有 upstream_user_agent，恢复 App Server 原生透传）",
    initialValue: buildOfficialCodexUserAgent(codexCliVersion),
    validate: (input) => input.length <= 512 ? undefined : "User-Agent 过长",
  });
  if (prompts.isCancel(value)) return { action: "back" };
  const result = updateGatewaySetting({
    kind: "system.official-tui-identity",
    value: {
      clientIdentity: identity,
      upstreamUserAgent: value === "" ? null : value,
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
