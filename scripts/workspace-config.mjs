import { chmodSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, isAbsolute } from "node:path";

import { parse } from "dotenv";

export function readWorkspaceConfig(env) {
  const raw = required(env, "CODEX_WORKSPACES_JSON");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("CODEX_WORKSPACES_JSON 必须是有效 JSON");
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("CODEX_WORKSPACES_JSON 必须是非空数组");
  }
  const workspaces = parsed.map((workspace) => {
    if (!workspace || typeof workspace !== "object") {
      throw new Error("Workspace 配置必须是对象");
    }
    const id = String(workspace.id || "").trim();
    const name = String(workspace.name || "").trim();
    const cwd = String(workspace.cwd || "").trim();
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id) || !name || name.length > 64 || !isAbsolute(cwd)) {
      throw new Error("Workspace 必须包含有效的 id、name 和 cwd");
    }
    const resolvedCwd = realpathSync(cwd);
    if (!statSync(resolvedCwd).isDirectory()) {
      throw new Error(`Workspace ${id} 的 cwd 必须是目录`);
    }
    return { id, name, cwd: resolvedCwd };
  });
  const ids = new Set(workspaces.map((workspace) => workspace.id));
  if (ids.size !== workspaces.length) {
    throw new Error("Workspace ID 不能重复");
  }
  const defaultWorkspaceId = required(env, "CODEX_DEFAULT_WORKSPACE");
  const defaultWorkspace = workspaces.find((workspace) => workspace.id === defaultWorkspaceId);
  if (!defaultWorkspace) {
    throw new Error(`CODEX_DEFAULT_WORKSPACE 不存在：${defaultWorkspaceId}`);
  }
  return { workspaces, defaultWorkspace };
}

export function addWorkspaceToEnv({ envPath, cwd, id, name }) {
  const content = readFileSync(envPath, "utf8");
  chmodSync(envPath, 0o600);
  const env = parse(content);
  const { workspaces, defaultWorkspace } = readWorkspaceConfig(env);
  const resolvedCwd = realpathSync(cwd);
  if (!statSync(resolvedCwd).isDirectory()) {
    throw new Error("待注册 Workspace 的 cwd 必须是目录");
  }
  const existing = workspaces.find((workspace) => workspace.cwd === resolvedCwd);
  if (existing) {
    return { added: false, workspace: existing, defaultWorkspace };
  }

  const workspaceName = normalizedName(name ?? basename(resolvedCwd));
  const baseId = normalizedId(id ?? workspaceName);
  let workspaceId = baseId;
  let suffix = 2;
  const usedIds = new Set(workspaces.map((workspace) => workspace.id));
  while (usedIds.has(workspaceId)) {
    workspaceId = `${baseId.slice(0, Math.max(1, 63 - String(suffix).length - 1))}-${suffix}`;
    suffix += 1;
  }
  const workspace = { id: workspaceId, name: workspaceName, cwd: resolvedCwd };
  const json = JSON.stringify([...workspaces, workspace]).replaceAll("'", "\\u0027");
  const updated = setEnvValue(content, "CODEX_WORKSPACES_JSON", `'${json}'`);
  const temporaryPath = `${envPath}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, updated, { mode: 0o600 });
  renameSync(temporaryPath, envPath);
  return { added: true, workspace, defaultWorkspace };
}

function normalizedName(value) {
  const normalized = String(value).trim();
  if (!normalized || normalized.length > 64 || /[\r\n]/.test(normalized)) {
    throw new Error("Workspace 名称必须为 1–64 个字符且不能换行");
  }
  return normalized;
}

function normalizedId(value) {
  const normalized = String(value)
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return normalized || "workspace";
}

function setEnvValue(content, key, value) {
  const lines = content.split(/\r?\n/);
  const index = lines.findIndex((line) => line.startsWith(`${key}=`));
  const next = `${key}=${value}`;
  if (index === -1) {
    if (lines.at(-1) !== "") {
      lines.push("");
    }
    lines.push(next);
  } else {
    lines[index] = next;
  }
  return lines.join("\n");
}

function required(values, key) {
  const value = values[key]?.trim();
  if (!value) {
    throw new Error(`.env 缺少 ${key}`);
  }
  return value;
}
