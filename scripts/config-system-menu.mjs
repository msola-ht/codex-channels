import { writeGatewayConfig } from "../runtime/gateway-config.mjs";
import { writeGatewayConfigActivationNotice } from "./config-activation-notice.mjs";
import {
  loadGatewaySettings,
  updateGatewaySetting,
} from "./config-management.mjs";

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
      { value: "debug", label: "调试模式", hint: "控制全局脱敏调试日志与渠道技术字段" },
      { value: "approval_timeout", label: "审批超时", hint: "approval.timeout_seconds（30–3600 秒）" },
      { value: "sandbox", label: "Codex Sandbox", hint: "read-only 或 workspace-write" },
      { value: "default_workspace", label: "默认工作区", hint: "default_workspace" },
      {
        value: "default_model",
        label: "渠道新会话模型覆盖",
        hint: "仅覆盖 Gateway 新 Thread；全局模型与思考等级请用 codexc setup",
      },
      { value: "back", label: "返回", hint: "返回配置菜单" },
    ],
  });
  if (prompts.isCancel(section) || section === "back") return { action: "back" };
  if (section === "debug") return debugSetup({ environment, input, output, prompts });
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
  writeGatewayConfigActivationNotice(output, environment, "restart");
  return { timeoutSeconds: parsed, configPath: result.configPath };
}

async function runSandbox({ environment, output, prompts, writeConfig }) {
  const settings = loadGatewaySettings(environment);
  const selected = await prompts.select({
    message: "Codex Sandbox",
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
  output.write(`Codex Sandbox 已设为${selected}：${result.configPath}\n`);
  writeGatewayConfigActivationNotice(output, environment, "restart");
  return { sandbox: selected, configPath: result.configPath };
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
  writeGatewayConfigActivationNotice(output, environment, "restart");
  return { defaultWorkspace: selected, configPath: result.configPath };
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
  writeGatewayConfigActivationNotice(output, environment, "restart");
  return { defaultModel: normalized || null, configPath: result.configPath };
}
