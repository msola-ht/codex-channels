import { readFileSync } from "node:fs";
import { join } from "node:path";

import { parse } from "smol-toml";

import { codexHomePath } from "./codex-home.mjs";

const nonRoleAgentKeys = new Set([
  "enabled",
  "max_concurrent_threads_per_session",
  "max_threads",
  "max_depth",
  "default_subagent_model",
  "default_subagent_reasoning_effort",
  "job_max_runtime_seconds",
  "interrupt_message",
]);

export function agentRolesConfigPath(environment = process.env) {
  return join(codexHomePath(environment), "config.toml");
}

export function listConfiguredAgentRoles(environment = process.env) {
  const path = agentRolesConfigPath(environment);
  let document;
  try {
    document = parse(readFileSync(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw new Error("Codex 子代理角色配置无法安全读取", { cause: error });
  }
  const agents = record(document.agents);
  return Object.entries(agents)
    .filter(([name, value]) => !nonRoleAgentKeys.has(name) && record(value).description !== undefined)
    .map(([name, value]) => ({
      name,
      description: typeof record(value).description === "string"
        ? record(value).description
        : null,
    }));
}

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
}
