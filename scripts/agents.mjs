import {
  existsSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { parse } from "smol-toml";

import { loadManagedModelProvider } from "../runtime/model-provider-runtime.mjs";
import { managedModelProviderRoleConfigPath } from "../runtime/model-provider-runtime.mjs";

const featureTableHeader = "[features.multi_agent_v2]";
const featureHeader = "[features]";
const roleHeader = "[agents.ds]";

export function agentsConfigPath(environment = process.env) {
  const codexHome = resolve(environment.CODEX_HOME?.trim() || join(homedir(), ".codex"));
  return join(codexHome, "config.toml");
}

export function agentsStatus(environment = process.env) {
  const configPath = agentsConfigPath(environment);
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

export function enableDeepseekRole(environment = process.env) {
  if (loadManagedModelProvider(environment) === undefined) {
    throw new Error(
      "DeepSeek 切换模式未配置；请先运行 codexc setup 选择 OpenAI + DeepSeek 切换模式",
    );
  }
  const configPath = agentsConfigPath(environment);
  const roleConfigPath = managedModelProviderRoleConfigPath(environment);
  const lines = readConfigLines(configPath);
  setMultiAgentV2(lines, true);
  upsertDsRole(lines, roleConfigPath);
  writeConfig(configPath, lines);
}

export function disableDeepseekRole(environment = process.env) {
  const configPath = agentsConfigPath(environment);
  if (!existsSync(configPath)) return;
  const lines = readConfigLines(configPath);
  removeDsRole(lines);
  setMultiAgentV2(lines, false);
  writeConfig(configPath, lines);
}

function readConfigLines(configPath) {
  if (!existsSync(configPath)) return [];
  return readFileSync(configPath, "utf8").split("\n");
}

function writeConfig(configPath, lines) {
  const content = `${lines.join("\n").trimEnd()}\n`;
  parse(content);
  const mode = existsSync(configPath) ? statSync(configPath).mode : 0o600;
  writeFileSync(configPath, content, { mode });
}

function setMultiAgentV2(lines, enabled) {
  if (lines.some((line) => line.trim() === featureTableHeader)) {
    setSectionValue(lines, featureTableHeader, "enabled", String(enabled));
    return;
  }
  const featuresIndex = lines.findIndex((line) => line.trim() === featureHeader);
  if (featuresIndex !== -1) {
    replaceFeatureKey(lines, featuresIndex, enabled);
    return;
  }
  lines.push("", featureHeader, `multi_agent_v2 = ${enabled}`);
}

function replaceFeatureKey(lines, featuresIndex, enabled) {
  const keyPattern = /^(\s*multi_agent_v2\s*=\s*)(.+)$/u;
  const end = sectionEnd(lines, featuresIndex);
  for (let index = featuresIndex + 1; index < end; index += 1) {
    const match = keyPattern.exec(lines[index]);
    if (match === null) continue;
    const current = match[2];
    if (current === "true" || current === "false") {
      lines[index] = `${match[1]}${enabled}`;
      return;
    }
    if (/^\{[\s\S]*\}$/u.test(current)) {
      lines[index] = `${match[1]}${enabled ? "{ enabled = true }" : "{ enabled = false }"}`;
      return;
    }
  }
  lines.splice(featuresIndex + 1, 0, `multi_agent_v2 = ${enabled}`);
}

function upsertDsRole(lines, roleConfigPath) {
  const index = lines.findIndex((line) => line.trim() === roleHeader);
  if (index !== -1) {
    setSectionValue(lines, roleHeader, "description", tomlString("DeepSeek 子代理"));
    setSectionValue(lines, roleHeader, "config_file", tomlString(roleConfigPath));
    setSectionValue(lines, roleHeader, "nickname_candidates", '["DeepSeek"]');
    return;
  }
  lines.push(
    "",
    roleHeader,
    `description = ${tomlString("DeepSeek 子代理")}`,
    `config_file = ${tomlString(roleConfigPath)}`,
    'nickname_candidates = ["DeepSeek"]',
  );
}

function removeDsRole(lines) {
  const index = lines.findIndex((line) => line.trim() === roleHeader);
  if (index === -1) return;
  lines.splice(index, sectionEnd(lines, index) - index);
}

function setSectionValue(lines, header, key, value) {
  const index = lines.findIndex((line) => line.trim() === header);
  if (index === -1) return;
  const end = sectionEnd(lines, index);
  const keyPattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`, "u");
  for (let cursor = index + 1; cursor < end; cursor += 1) {
    if (keyPattern.test(lines[cursor])) {
      lines[cursor] = `${key} = ${value}`;
      return;
    }
  }
  lines.splice(index + 1, 0, `${key} = ${value}`);
}

function sectionEnd(lines, headerIndex) {
  let cursor = headerIndex + 1;
  while (
    cursor < lines.length
    && !/^\[[^\]]+\]\s*$/u.test(lines[cursor].trim())
  ) {
    cursor += 1;
  }
  return cursor;
}

function tomlString(value) {
  return JSON.stringify(String(value));
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
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

const command = process.argv[2];
if (command === undefined || command === "-h" || command === "--help") {
  console.log(usage);
  process.exitCode = command === undefined ? 1 : 0;
} else if (command === "enable-deepseek") {
  enableDeepseekRole(process.env);
  console.log("已启用 multi_agent_v2 并注册 DS 子代理角色（agents.ds）。");
  console.log("运行 codexc service restart all 后生效。");
  printStatus(process.env);
} else if (command === "disable-deepseek") {
  disableDeepseekRole(process.env);
  console.log("已移除 DS 子代理角色并关闭 multi_agent_v2。");
  console.log("运行 codexc service restart all 后生效。");
} else if (command === "status") {
  printStatus(process.env);
} else {
  console.error(`未知子命令：${command}`);
  console.error(usage);
  process.exitCode = 1;
}
