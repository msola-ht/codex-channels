import {
  existsSync,
  readFileSync,
  unlinkSync,
} from "node:fs";
import { pathToFileURL } from "node:url";

import { parse } from "smol-toml";

import { agentRolesConfigPath } from "../runtime/agent-roles.mjs";
import { writeCliMessage } from "../runtime/cli-presentation.mjs";
import { loadManagedModelProvider } from "../runtime/model-provider-runtime.mjs";
import { managedModelProviderRoleConfigPath } from "../runtime/model-provider-runtime.mjs";
import { removeManagedModelProviderRoleConfig } from "../runtime/model-provider-runtime.mjs";
import { writeManagedModelProviderRoleConfig } from "../runtime/model-provider-runtime.mjs";
import { writePrivateFileAtomicSync } from "../runtime/private-file.mjs";
import { updateCodexUserConfig } from "./codex-user-config.mjs";

const dsRoleDescription =
  "DeepSeek 单次子代理；仅处理当前用户消息中的完整任务，必须使用 fork_turns=1，不能接收后续消息";

export function agentsStatus(environment = process.env) {
  const configPath = agentRolesConfigPath(environment);
  const roleConfigPath = managedModelProviderRoleConfigPath(environment);
  let multiAgentV2Enabled = false;
  let dsRoleConfigured = false;
  if (existsSync(configPath)) {
    try {
      const document = parse(readFileSync(configPath, "utf8"));
      const feature = document.features?.multi_agent_v2;
      multiAgentV2Enabled = feature === true || feature?.enabled === true;
      dsRoleConfigured = document.agents?.ds !== undefined;
    } catch {
      // 配置无法解析时按未配置处理，错误由 enable 命令显式提示。
    }
  }
  return {
    configPath,
    roleConfigPath,
    multiAgentV2Enabled,
    dsRoleConfigured,
  };
}

export async function enableDeepseekRole(
  environment = process.env,
  { updateConfig = updateCodexUserConfig } = {},
) {
  if (loadManagedModelProvider(environment) === undefined) {
    throw new Error(
      "DeepSeek 切换模式未配置；请先运行 codexc setup 选择 OpenAI + DeepSeek 切换模式",
    );
  }
  assertDeepseekRoleAvailable(environment);
  const roleConfigPath = managedModelProviderRoleConfigPath(environment);
  const previousRoleConfig = readOptionalFile(roleConfigPath);
  writeManagedModelProviderRoleConfig(environment);
  const writtenRoleConfig = readOptionalFile(roleConfigPath);
  try {
    await updateConfig(environment, (config) => {
      assertDeepseekRoleAvailableInConfig(config, environment);
      return [{
        keyPath: "features.multi_agent_v2",
        value: true,
      }, {
        keyPath: "agents.ds",
        value: {
          description: dsRoleDescription,
          config_file: roleConfigPath,
          nickname_candidates: ["DeepSeek"],
        },
      }];
    });
  } catch (error) {
    try {
      restoreOptionalFile(roleConfigPath, previousRoleConfig, writtenRoleConfig);
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        "DS 子代理配置失败，且角色文件已被其他进程修改",
        { cause: rollbackError },
      );
    }
    throw error;
  }
}

export function assertDeepseekRoleAvailable(environment = process.env) {
  const configPath = agentRolesConfigPath(environment);
  if (!existsSync(configPath)) return;
  let document;
  try {
    document = parse(readFileSync(configPath, "utf8"));
  } catch {
    throw new Error("现有 Codex config.toml 无法安全读取或解析");
  }
  assertDeepseekRoleAvailableInConfig(document, environment);
}

export async function disableDeepseekRole(
  environment = process.env,
  { updateConfig = updateCodexUserConfig } = {},
) {
  const configPath = agentRolesConfigPath(environment);
  if (!existsSync(configPath)) return;
  await updateConfig(environment, (config) => {
    assertDeepseekRoleAvailableInConfig(config, environment);
    return [{
      keyPath: "agents.ds",
      value: null,
    }, {
      keyPath: "features.multi_agent_v2",
      value: false,
    }];
  });
  removeManagedModelProviderRoleConfig(environment);
}

export async function removeManagedDeepseekRole(
  environment = process.env,
  { updateConfig = updateCodexUserConfig } = {},
) {
  const configPath = agentRolesConfigPath(environment);
  if (!existsSync(configPath)) return;
  let removed = false;
  await updateConfig(environment, (config) => {
    if (!isManagedDeepseekRole(config, environment)) return [];
    removed = true;
    return [{ keyPath: "agents.ds", value: null }];
  });
  if (!removed) return;
  removeManagedModelProviderRoleConfig(environment);
}

function assertDeepseekRoleAvailableInConfig(config, environment) {
  const role = record(config.agents).ds;
  if (
    role !== undefined
    && record(role).config_file !== managedModelProviderRoleConfigPath(environment)
  ) {
    throw new Error("agents.ds 已由用户配置；请先改名或移除该角色");
  }
}

function isManagedDeepseekRole(config, environment) {
  return record(record(config.agents).ds).config_file
    === managedModelProviderRoleConfigPath(environment);
}

function record(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function readOptionalFile(path) {
  try {
    return readFileSync(path);
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
}

function restoreOptionalFile(path, content, expectedCurrent) {
  const current = readOptionalFile(path);
  if (!sameOptionalContent(current, expectedCurrent)) {
    throw new Error("DS 子代理角色文件在配置事务期间发生变化");
  }
  if (content === undefined) {
    try {
      unlinkSync(path);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    return;
  }
  writePrivateFileAtomicSync(path, content);
}

function sameOptionalContent(left, right) {
  if (left === undefined || right === undefined) return left === right;
  return left.equals(right);
}

function printStatus(environment) {
  const status = agentsStatus(environment);
  console.log(`配置：${status.configPath}`);
  console.log(`multi_agent_v2：${status.multiAgentV2Enabled ? "已启用" : "未启用"}`);
  console.log(`DS 子代理角色：${status.dsRoleConfigured ? "已配置" : "未配置"}`);
  console.log(`角色配置文件：${status.roleConfigPath}`);
}

const usage = `用法：codexc agents <enable-deepseek|disable-deepseek|status>

  enable-deepseek   启用 multi_agent_v2 并注册 DeepSeek 子代理角色（agents.ds）
  disable-deepseek  移除 agents.ds 角色并关闭 multi_agent_v2
  status            查看当前状态`;

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const command = process.argv[2];
  if (command === undefined || command === "-h" || command === "--help") {
    console.log(usage);
    process.exitCode = command === undefined ? 1 : 0;
  } else if (command === "enable-deepseek") {
    await enableDeepseekRole(process.env);
    writeCliMessage("success", "已启用 multi_agent_v2 并注册 DS 子代理角色（agents.ds）。");
    writeCliMessage("remediation", "运行 codexc service restart all 后生效。");
    printStatus(process.env);
  } else if (command === "disable-deepseek") {
    await disableDeepseekRole(process.env);
    writeCliMessage("success", "已移除 DS 子代理角色并关闭 multi_agent_v2。");
    writeCliMessage("remediation", "运行 codexc service restart all 后生效。");
  } else if (command === "status") {
    printStatus(process.env);
  } else {
    writeCliMessage("failure", `未知子命令：${command}`);
    console.error(usage);
    process.exitCode = 1;
  }
}
