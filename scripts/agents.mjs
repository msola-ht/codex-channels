import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { parse } from "smol-toml";

import { agentRolesConfigPath } from "../runtime/agent-roles.mjs";
import { writeCliMessage } from "../runtime/cli-presentation.mjs";
import { managedModelProviderDefinitions } from "../runtime/model-provider-definitions.mjs";
import {
  loadManagedModelProviderRole,
  managedModelProviderRoleConfigPath,
  removeManagedModelProviderRoleConfig,
  validateConfiguredModelProviders,
  writeManagedModelProviderRoleConfig,
} from "../runtime/model-provider-runtime.mjs";
import { writePrivateFileAtomicSync } from "../runtime/private-file.mjs";
import { updateCodexUserConfig } from "./codex-user-config.mjs";

const managedRoleName = "external";
const legacyManagedRoleName = "ds";
const legacyManagedRoleConfigFileName = "codex-connect-ds-subagent.config.toml";
const roleDescription =
  "第三方模型单次子代理；仅处理当前用户消息中的完整任务，必须使用 fork_turns=1，不能接收后续消息";

export function agentsStatus(environment = process.env) {
  const configPath = agentRolesConfigPath(environment);
  const roleConfigPath = managedModelProviderRoleConfigPath(environment);
  const legacyRoleConfigPath = join(dirname(roleConfigPath), legacyManagedRoleConfigFileName);
  let multiAgentV2Enabled = false;
  let externalRoleConfigured = false;
  let legacyDsRoleConfigured = false;
  if (existsSync(configPath)) {
    try {
      const document = parse(readFileSync(configPath, "utf8"));
      const feature = document.features?.multi_agent_v2;
      multiAgentV2Enabled = feature === true || feature?.enabled === true;
      externalRoleConfigured = document.agents?.[managedRoleName] !== undefined;
      legacyDsRoleConfigured = record(document.agents?.[legacyManagedRoleName]).config_file
        === legacyRoleConfigPath;
    } catch {
      // 配置无法解析时按未配置处理，错误由 configure 命令显式提示。
    }
  }
  let selection;
  try {
    selection = loadManagedModelProviderRole(environment);
  } catch {
    // 状态命令仍显示角色存在；详细错误由配置命令给出。
  }
  return {
    configPath,
    roleConfigPath,
    multiAgentV2Enabled,
    externalRoleConfigured,
    legacyDsRoleConfigured,
    provider: selection?.provider,
    model: selection?.model,
  };
}

export async function configureThirdPartyRole(
  provider,
  model,
  environment = process.env,
  { updateConfig = updateCodexUserConfig } = {},
) {
  const definition = providerDefinition(provider);
  if (!validateConfiguredModelProviders(environment).some((entry) => entry.provider === provider)) {
    throw new Error(`${definition.displayName} Provider 尚未配置；请先运行 codexc setup`);
  }
  assertThirdPartyRoleAvailable(environment);
  const roleConfigPath = managedModelProviderRoleConfigPath(environment);
  const legacyRoleConfigPath = join(dirname(roleConfigPath), legacyManagedRoleConfigFileName);
  const previousRoleConfig = readOptionalFile(roleConfigPath);
  const selection = writeManagedModelProviderRoleConfig(
    environment,
    { provider, ...(model ? { model } : {}) },
  );
  const writtenRoleConfig = readOptionalFile(roleConfigPath);
  let removeLegacyRole = false;
  try {
    await updateConfig(environment, (config) => {
      assertThirdPartyRoleAvailableInConfig(config, environment);
      removeLegacyRole = isLegacyManagedRole(config, legacyRoleConfigPath);
      return [{
        keyPath: "features.multi_agent_v2",
        value: true,
      }, {
        keyPath: `agents.${managedRoleName}`,
        value: {
          description: roleDescription,
          config_file: roleConfigPath,
          nickname_candidates: [definition.displayName],
        },
      }, ...(removeLegacyRole
        ? [{ keyPath: `agents.${legacyManagedRoleName}`, value: null }]
        : [])];
    });
  } catch (error) {
    try {
      restoreOptionalFile(roleConfigPath, previousRoleConfig, writtenRoleConfig);
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        "第三方子代理配置失败，且角色文件已被其他进程修改",
        { cause: rollbackError },
      );
    }
    throw error;
  }
  if (removeLegacyRole) removeLegacyRoleConfig(legacyRoleConfigPath);
  return selection;
}

export function assertThirdPartyRoleAvailable(environment = process.env) {
  const configPath = agentRolesConfigPath(environment);
  if (!existsSync(configPath)) return;
  let document;
  try {
    document = parse(readFileSync(configPath, "utf8"));
  } catch {
    throw new Error("现有 Codex config.toml 无法安全读取或解析");
  }
  assertThirdPartyRoleAvailableInConfig(document, environment);
}

export async function disableThirdPartyRole(
  environment = process.env,
  { updateConfig = updateCodexUserConfig } = {},
) {
  assertThirdPartyRoleAvailable(environment);
  await removeManagedThirdPartyRole(environment, { updateConfig, disableFeature: true });
}

export async function removeManagedThirdPartyRole(
  environment = process.env,
  { updateConfig = updateCodexUserConfig, provider, disableFeature = false } = {},
) {
  const configPath = agentRolesConfigPath(environment);
  if (!existsSync(configPath)) return;
  const selection = provider ? loadManagedModelProviderRole(environment) : undefined;
  if (provider && selection?.provider !== provider) return;
  const legacyRoleConfigPath = join(
    dirname(managedModelProviderRoleConfigPath(environment)),
    legacyManagedRoleConfigFileName,
  );
  let removed = false;
  await updateConfig(environment, (config) => {
    const managedExternal = isManagedThirdPartyRole(config, environment);
    const managedLegacyDs = isLegacyManagedRole(config, legacyRoleConfigPath);
    if (!managedExternal && !managedLegacyDs) return [];
    removed = true;
    const otherRoles = Object.keys(record(config.agents)).filter(
      (name) => name !== managedRoleName && name !== legacyManagedRoleName,
    );
    return [
      ...(managedExternal ? [{ keyPath: `agents.${managedRoleName}`, value: null }] : []),
      ...(managedLegacyDs ? [{ keyPath: `agents.${legacyManagedRoleName}`, value: null }] : []),
      ...(disableFeature && otherRoles.length === 0
        ? [{ keyPath: "features.multi_agent_v2", value: false }]
        : []),
    ];
  });
  if (!removed) return;
  removeManagedModelProviderRoleConfig(environment);
  removeLegacyRoleConfig(legacyRoleConfigPath);
}

function providerDefinition(provider) {
  const definition = managedModelProviderDefinitions.find((candidate) => candidate.id === provider);
  if (!definition) {
    throw new Error(`未知第三方 Provider：${provider}；可选：${
      managedModelProviderDefinitions.map((candidate) => candidate.id).join("、")
    }`);
  }
  return definition;
}

function assertThirdPartyRoleAvailableInConfig(config, environment) {
  const role = record(config.agents)[managedRoleName];
  if (
    role !== undefined
    && record(role).config_file !== managedModelProviderRoleConfigPath(environment)
  ) {
    throw new Error(`agents.${managedRoleName} 已由用户配置；请先改名或移除该角色`);
  }
}

function isManagedThirdPartyRole(config, environment) {
  return record(record(config.agents)[managedRoleName]).config_file
    === managedModelProviderRoleConfigPath(environment);
}

function isLegacyManagedRole(config, legacyRoleConfigPath) {
  return record(record(config.agents)[legacyManagedRoleName]).config_file === legacyRoleConfigPath;
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

function removeOptionalFile(path) {
  try {
    unlinkSync(path);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

function removeLegacyRoleConfig(path) {
  try {
    removeOptionalFile(path);
  } catch {
    // 旧角色已经从 config.toml 解除引用；辅助文件清理失败不回滚已完成的配置事务。
  }
}

function restoreOptionalFile(path, content, expectedCurrent) {
  const current = readOptionalFile(path);
  if (!sameOptionalContent(current, expectedCurrent)) {
    throw new Error("第三方子代理角色文件在配置事务期间发生变化");
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
  console.log(`第三方子代理：${status.externalRoleConfigured ? "已配置" : "未配置"}`);
  console.log(`旧版 DS 子代理角色：${status.legacyDsRoleConfigured ? "已配置（迁移前状态）" : "未配置"}`);
  if (status.provider) console.log(`Provider：${status.provider}`);
  if (status.model) console.log(`模型：${status.model}`);
  console.log(`角色配置文件：${status.roleConfigPath}`);
}

const usage = `用法：codexc agents <configure|disable|status> [参数]

  configure <Provider> [模型]  配置共享第三方子代理（agents.external）
  disable                    移除共享第三方子代理
  status                     查看当前状态

Provider：${managedModelProviderDefinitions.map((definition) => definition.id).join("、")}`;

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runAgentsCli().catch((error) => {
    writeCliMessage("failure", error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

async function runAgentsCli() {
  const [command, provider, model, ...rest] = process.argv.slice(2);
  if (command === undefined || command === "-h" || command === "--help") {
    console.log(usage);
    process.exitCode = command === undefined ? 1 : 0;
  } else if (command === "configure" && provider && rest.length === 0) {
    const selection = await configureThirdPartyRole(provider, model, process.env);
    writeCliMessage(
      "success",
      `已配置共享第三方子代理：${selection.provider} / ${selection.model}（agents.external）。`,
    );
    writeCliMessage("remediation", "运行 codexc service restart all 后生效。");
    printStatus(process.env);
  } else if (command === "disable" && provider === undefined) {
    await disableThirdPartyRole(process.env);
    writeCliMessage("success", "已移除共享第三方子代理。");
    writeCliMessage("remediation", "运行 codexc service restart all 后生效。");
  } else if (command === "status" && provider === undefined) {
    printStatus(process.env);
  } else {
    throw new Error(usage);
  }
}
