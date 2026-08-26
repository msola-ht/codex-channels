import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { parse } from "smol-toml";

import { agentRolesConfigPath } from "../runtime/agent-roles.mjs";
import {
  writeCliMessage,
  writeCliRemediationRestartAll,
} from "../runtime/cli-presentation.mjs";
import { loadManagedModelProviderDefinitions } from "../runtime/model-provider-definitions.mjs";
import {
  loadCustomModelProviderRoleCandidates,
  loadManagedModelProviderSettings,
  loadThirdPartyModelProviderRole,
  managedModelProviderRoleConfigPath,
  removeManagedModelProviderRoleConfig,
  validateConfiguredModelProviders,
  writeThirdPartyModelProviderRoleConfig,
} from "../runtime/model-provider-runtime.mjs";
import { writePrivateFileAtomicSync } from "../runtime/private-file.mjs";
import { updateCodexUserConfig } from "./codex-user-config.mjs";
import { withModelProviderManagementTransaction } from "./model-provider-management-transaction.mjs";

const managedRoleName = "external";
const legacyManagedRoleName = "ds";
const legacyManagedRoleConfigFileName = "codex-connect-ds-subagent.config.toml";
const roleDescription =
  "第三方模型单次子代理；仅处理当前用户消息中的完整任务，必须使用 fork_turns=1，不能接收后续消息";

export class AgentsManagementError extends Error {
  constructor(code, field, message, options) {
    super(message, options);
    this.name = "AgentsManagementError";
    this.code = code;
    this.field = field;
  }
}

export function loadThirdPartyAgentProviders(environment = process.env) {
  return [
    ...loadManagedModelProviderSettings(environment),
    ...loadCustomModelProviderRoleCandidates(environment).map((provider) => ({
      provider: provider.provider,
      displayName: provider.displayName,
      model: provider.model,
      reasoningEffort: provider.reasoningEffort,
      mode: provider.mode,
      models: [{
        model: provider.model,
        displayName: provider.model,
        contextWindow: 0,
        reasoningEffort: provider.reasoningEffort,
        reasoningEfforts: [],
      }],
    })),
  ];
}

export function previewThirdPartyAgentChange(
  input,
  {
    environment = process.env,
    loadProviders = loadThirdPartyAgentProviders,
    loadStatus = agentsStatus,
    validateRoleAvailability = true,
  } = {},
) {
  if (input?.action !== "configure" && input?.action !== "disable") {
    throw agentInvalid("invalid-action", "action", "子代理操作必须是 configure 或 disable");
  }
  const status = loadStatus(environment);
  const current = status.externalRoleConfigured || status.legacyDsRoleConfigured
    ? {
        configured: true,
        provider: status.provider ?? null,
        model: status.model ?? null,
      }
    : { configured: false, provider: null, model: null };
  if (input.action === "disable") {
    return {
      operation: "disable",
      current,
      willChange: current.configured,
      activation: current.configured ? "restart-all" : "none",
    };
  }
  const providerId = requiredAgentString(input.provider, "provider", "Provider 不能为空");
  const provider = loadProviders(environment)
    .find((candidate) => candidate.provider === providerId);
  if (provider === undefined) {
    throw agentInvalid(
      "provider-not-configured",
      "provider",
      `第三方 Provider 未配置：${providerId}`,
    );
  }
  const model = optionalString(input.model) ?? provider.model;
  const modelOption = provider.models.find((candidate) => candidate.model === model);
  if (modelOption === undefined) {
    throw agentInvalid(
      "model-not-supported",
      "model",
      `${provider.displayName} 不支持模型：${model}`,
    );
  }
  if (validateRoleAvailability) {
    try {
      assertThirdPartyRoleAvailable(environment);
    } catch (error) {
      throw agentInvalid(
        "role-unavailable",
        "action",
        error instanceof Error ? error.message : String(error),
        error,
      );
    }
  }
  return {
    operation: "configure",
    current,
    selection: {
      provider: provider.provider,
      providerDisplayName: provider.displayName,
      model: modelOption.model,
      modelDisplayName: modelOption.displayName,
    },
    willChange: !current.configured
      || current.provider !== provider.provider
      || current.model !== modelOption.model,
    activation: "restart-all",
  };
}

export async function applyThirdPartyAgentChange(
  input,
  {
    environment = process.env,
    loadProviders = loadThirdPartyAgentProviders,
    loadStatus = agentsStatus,
    configureRole = configureThirdPartyRole,
    disableRole = disableThirdPartyRole,
    validateRoleAvailability = configureRole === configureThirdPartyRole,
  } = {},
) {
  const preview = previewThirdPartyAgentChange(input, {
    environment,
    loadProviders,
    loadStatus,
    validateRoleAvailability,
  });
  try {
    if (preview.operation === "disable") {
      const removed = preview.willChange ? await disableRole(environment) : false;
      return {
        action: removed ? "disabled" : "unchanged",
        activation: removed ? "restart-all" : "none",
        previous: preview.current,
      };
    }
    const selection = await configureRole(
      preview.selection.provider,
      preview.selection.model,
      environment,
    );
    return {
      action: "configured",
      activation: "restart-all",
      previous: preview.current,
      selection: {
        provider: selection.provider,
        model: selection.model,
      },
    };
  } catch (error) {
    if (error instanceof AgentsManagementError) throw error;
    throw agentInvalid(
      "operation-failed",
      "action",
      error instanceof Error ? error.message : String(error),
      error,
    );
  }
}

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
      externalRoleConfigured = isManagedThirdPartyRole(document, environment);
      legacyDsRoleConfigured = record(document.agents?.[legacyManagedRoleName]).config_file
        === legacyRoleConfigPath;
    } catch {
      // 配置无法解析时按未配置处理，错误由 configure 命令显式提示。
    }
  }
  let selection;
  try {
    selection = loadThirdPartyModelProviderRole(environment);
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
  return withThirdPartyRoleTransaction(environment, async () => {
    const definition = providerDefinition(provider, environment);
    assertThirdPartyRoleAvailable(environment);
    const roleConfigPath = managedModelProviderRoleConfigPath(environment);
    const legacyRoleConfigPath = join(dirname(roleConfigPath), legacyManagedRoleConfigFileName);
    const previousRoleConfig = readOptionalFile(roleConfigPath);
    const selection = writeThirdPartyModelProviderRoleConfig(
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
  });
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
  return removeManagedThirdPartyRole(environment, { updateConfig, disableFeature: true });
}

export function assertThirdPartyRoleDoesNotUseProvider(
  provider,
  environment = process.env,
) {
  const selection = loadThirdPartyModelProviderRole(environment);
  if (selection?.provider === provider) {
    throw new Error(
      `Provider ${provider} 正由 agents.external 使用；请先切换共享第三方子代理或运行 codexc agents disable`,
    );
  }
}

export async function removeManagedThirdPartyRole(
  environment = process.env,
  { updateConfig = updateCodexUserConfig, provider, disableFeature = false } = {},
) {
  return withThirdPartyRoleTransaction(environment, async () => {
    const configPath = agentRolesConfigPath(environment);
    if (!existsSync(configPath)) return false;
    const selection = provider ? loadThirdPartyModelProviderRole(environment) : undefined;
    if (provider && selection?.provider !== provider) return false;
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
    if (!removed) return false;
    removeManagedModelProviderRoleConfig(environment);
    removeLegacyRoleConfig(legacyRoleConfigPath);
    return true;
  });
}

async function withThirdPartyRoleTransaction(environment, operation) {
  return withModelProviderManagementTransaction(environment, operation);
}

function providerDefinition(provider, environment = process.env) {
  const definitions = loadManagedModelProviderDefinitions(environment);
  const definition = definitions
    .find((candidate) => candidate.id === provider);
  if (definition !== undefined) {
    if (!validateConfiguredModelProviders(environment).some((entry) => entry.provider === provider)) {
      throw new Error(`${definition.displayName} Provider 尚未配置；请先运行 codexc setup`);
    }
    return definition;
  }
  const custom = loadCustomModelProviderRoleCandidates(environment)
    .find((candidate) => candidate.provider === provider);
  if (custom !== undefined) return { id: custom.provider, displayName: custom.displayName };
  throw new Error(`未知或未配置的第三方 Provider：${provider}`);
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

function optionalString(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function requiredAgentString(value, field, message) {
  const normalized = optionalString(value);
  if (normalized === undefined) throw agentInvalid("required", field, message);
  return normalized;
}

function agentInvalid(code, field, message, cause) {
  return new AgentsManagementError(
    code,
    field,
    message,
    cause === undefined ? undefined : { cause },
  );
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

function printStatus(environment, { json = false, output = process.stdout } = {}) {
  const status = agentsStatus(environment);
  if (json) {
    output.write(`${JSON.stringify({
      configPath: status.configPath,
      roleConfigPath: status.roleConfigPath,
      multiAgentV2Enabled: status.multiAgentV2Enabled,
      externalRoleConfigured: status.externalRoleConfigured,
      legacyDsRoleConfigured: status.legacyDsRoleConfigured,
      provider: status.provider ?? null,
      model: status.model ?? null,
    }, null, 2)}\n`);
    return;
  }
  output.write(`配置：${status.configPath}\n`);
  output.write(`multi_agent_v2：${status.multiAgentV2Enabled ? "已启用" : "未启用"}\n`);
  output.write(`第三方子代理：${status.externalRoleConfigured ? "已配置" : "未配置"}\n`);
  output.write(`旧版 DS 子代理角色：${status.legacyDsRoleConfigured ? "已配置（迁移前状态）" : "未配置"}\n`);
  if (status.provider) output.write(`Provider：${status.provider}\n`);
  if (status.model) output.write(`模型：${status.model}\n`);
  output.write(`角色配置文件：${status.roleConfigPath}\n`);
}

const usage = `用法：codexc agents <configure|disable|status> [参数]

  configure <Provider> [模型]  配置共享第三方子代理（agents.external）
  disable                    移除共享第三方子代理
  status [--json]            查看当前状态

内置 Provider：${loadManagedModelProviderDefinitions(process.env)
  .map((definition) => definition.id).join("、")}
自定义 Provider：使用 codexc setup 已配置的固定或切换模式 Provider ID`;

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
    const result = await applyThirdPartyAgentChange(
      { action: "configure", provider, model },
      { environment: process.env },
    );
    const selection = result.selection;
    writeCliMessage(
      "success",
      `已配置共享第三方子代理：${selection.provider} / ${selection.model}（agents.external）。`,
    );
    writeCliRemediationRestartAll();
    printStatus(process.env);
  } else if (command === "disable" && provider === undefined) {
    const result = await applyThirdPartyAgentChange(
      { action: "disable" },
      { environment: process.env },
    );
    if (result.action === "disabled") {
      writeCliMessage("success", "已移除共享第三方子代理。");
      writeCliRemediationRestartAll();
    } else {
      writeCliMessage("note", "当前没有本项目管理的第三方子代理，无需处理。");
    }
  } else if (
    command === "status"
    && (provider === undefined || provider === "--json")
    && model === undefined
    && rest.length === 0
  ) {
    printStatus(process.env, { json: provider === "--json" });
  } else {
    throw new Error(usage);
  }
}
