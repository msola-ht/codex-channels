import { chmodSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, isAbsolute } from "node:path";

import { parse } from "dotenv";

export function readWorkspaceConfig(env) {
  const parsed = parseWorkspaceConfig(env);
  const workspaces = parsed.workspaces.map((workspace) => {
    const directory = inspectWorkspaceDirectory(workspace.cwd);
    if (!directory.valid) {
      throw new Error(`Workspace ${workspace.id} 的目录不存在或不是目录：${workspace.cwd}`);
    }
    return { ...workspace, cwd: directory.cwd };
  });
  const defaultWorkspace = workspaces.find(
    (workspace) => workspace.id === parsed.defaultWorkspaceId,
  );
  if (!defaultWorkspace) {
    throw new Error(`CODEX_DEFAULT_WORKSPACE 不存在：${parsed.defaultWorkspaceId}`);
  }
  return { workspaces, defaultWorkspace };
}

export function addWorkspaceToEnv({ envPath, cwd, id, name, pruneMissing = false }) {
  const content = readFileSync(envPath, "utf8");
  chmodSync(envPath, 0o600);
  const env = parse(content);
  const parsed = parseWorkspaceConfig(env);
  if (
    !parsed.workspaces.some((workspace) => workspace.id === parsed.defaultWorkspaceId)
    && !pruneMissing
  ) {
    throw new Error([
      `CODEX_DEFAULT_WORKSPACE 不存在：${parsed.defaultWorkspaceId}`,
      "确认配置需要修复后，运行 codexc ws add --prune-missing。",
    ].join("\n"));
  }
  const resolvedCwd = realpathSync(cwd);
  if (!statSync(resolvedCwd).isDirectory()) {
    throw new Error("待注册 Workspace 的 cwd 必须是目录");
  }

  const workspaces = [];
  const removedWorkspaces = [];
  for (const workspace of parsed.workspaces) {
    const directory = inspectWorkspaceDirectory(workspace.cwd);
    if (directory.valid) {
      workspaces.push({ ...workspace, cwd: directory.cwd });
      continue;
    }
    if (!pruneMissing) {
      throw new Error([
        `Workspace ${workspace.id} 的目录不存在或不是目录：${workspace.cwd}`,
        "确认这些目录不再使用后，运行 codexc ws add --prune-missing 清理失效项并添加当前目录。",
      ].join("\n"));
    }
    removedWorkspaces.push(workspace);
  }

  let workspace = workspaces.find((candidate) => candidate.cwd === resolvedCwd);
  const added = workspace === undefined;
  if (!workspace) {
    const workspaceName = normalizedName(name ?? basename(resolvedCwd));
    const baseId = normalizedId(id ?? workspaceName);
    let workspaceId = baseId;
    let suffix = 2;
    const usedIds = new Set(workspaces.map((candidate) => candidate.id));
    while (usedIds.has(workspaceId)) {
      workspaceId = `${baseId.slice(0, Math.max(1, 63 - String(suffix).length - 1))}-${suffix}`;
      suffix += 1;
    }
    workspace = { id: workspaceId, name: workspaceName, cwd: resolvedCwd };
    workspaces.push(workspace);
  }

  const retainedDefault = workspaces.find(
    (candidate) => candidate.id === parsed.defaultWorkspaceId,
  );
  const defaultWorkspace = retainedDefault ?? workspace;
  if (added || removedWorkspaces.length > 0 || defaultWorkspace.id !== parsed.defaultWorkspaceId) {
    const json = JSON.stringify(workspaces).replaceAll("'", "\\u0027");
    let updated = setEnvValue(content, "CODEX_WORKSPACES_JSON", `'${json}'`);
    updated = setEnvValue(updated, "CODEX_DEFAULT_WORKSPACE", defaultWorkspace.id);
    const temporaryPath = `${envPath}.${process.pid}.tmp`;
    writeFileSync(temporaryPath, updated, { mode: 0o600 });
    renameSync(temporaryPath, envPath);
  }
  return {
    added,
    workspace,
    defaultWorkspace,
    defaultChanged: defaultWorkspace.id !== parsed.defaultWorkspaceId,
    removedWorkspaces,
  };
}

function parseWorkspaceConfig(env) {
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
    return { id, name, cwd };
  });
  const ids = new Set(workspaces.map((workspace) => workspace.id));
  if (ids.size !== workspaces.length) {
    throw new Error("Workspace ID 不能重复");
  }
  return {
    workspaces,
    defaultWorkspaceId: required(env, "CODEX_DEFAULT_WORKSPACE"),
  };
}

function inspectWorkspaceDirectory(cwd) {
  try {
    const resolvedCwd = realpathSync(cwd);
    return statSync(resolvedCwd).isDirectory()
      ? { valid: true, cwd: resolvedCwd }
      : { valid: false };
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
      return { valid: false };
    }
    throw new Error(`Workspace 目录无法访问：${cwd}`);
  }
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
