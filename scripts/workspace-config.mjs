import {
  chmodSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, isAbsolute, resolve } from "node:path";

import { parse } from "dotenv";

import {
  acknowledgeConfigEvents,
  discardWorkspaceConfigEvents,
  enqueueWorkspaceAdded,
  readConfigEvents,
} from "../runtime/config-event-queue.mjs";

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

export function inspectWorkspaceConfig(env) {
  const parsed = parseWorkspaceConfig(env);
  return {
    defaultWorkspaceId: parsed.defaultWorkspaceId,
    workspaces: parsed.workspaces.map((workspace) => {
      try {
        const directory = inspectWorkspaceDirectory(workspace.cwd);
        return directory.valid
          ? { ...workspace, cwd: directory.cwd, status: "available" }
          : { ...workspace, status: "missing" };
      } catch {
        return { ...workspace, status: "inaccessible" };
      }
    }),
  };
}

export function addWorkspaceToEnv({
  envPath,
  cwd,
  id,
  name,
  pruneMissing = false,
  restoreDefault = false,
  fallbackDefaultWorkspace,
  eventQueuePath,
}) {
  const content = readFileSync(envPath, "utf8");
  chmodSync(envPath, 0o600);
  const env = parse(content);
  const parsed = parseWorkspaceConfig(env);
  if (
    !parsed.workspaces.some((workspace) => workspace.id === parsed.defaultWorkspaceId)
    && !pruneMissing
    && !restoreDefault
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

  let defaultWorkspace = workspaces.find(
    (candidate) => candidate.id === parsed.defaultWorkspaceId,
  );
  if ((restoreDefault || !defaultWorkspace) && fallbackDefaultWorkspace) {
    const fallback = ensureFallbackWorkspace(fallbackDefaultWorkspace);
    defaultWorkspace = upsertFallbackWorkspace(workspaces, fallback);
  }

  let workspace = workspaces.find((candidate) => candidate.cwd === resolvedCwd);
  const added = workspace === undefined;
  workspace ??= appendWorkspace(workspaces, {
    cwd: resolvedCwd,
    ...(id ? { id } : {}),
    ...(name ? { name } : {}),
  });
  defaultWorkspace ??= workspace;
  const previousDefault = parsed.workspaces.find(
    (candidate) => candidate.id === parsed.defaultWorkspaceId,
  );
  const defaultChanged = previousDefault === undefined
    || previousDefault.id !== defaultWorkspace.id
    || previousDefault.name !== defaultWorkspace.name
    || previousDefault.cwd !== defaultWorkspace.cwd;
  if (added || removedWorkspaces.length > 0 || defaultChanged) {
    if (eventQueuePath && removedWorkspaces.length > 0 && !added) {
      readConfigEvents(eventQueuePath);
    }
    const queuedEvent = added && eventQueuePath
      ? enqueueWorkspaceAdded(eventQueuePath, workspace)
      : undefined;
    try {
      writeWorkspaceConfig(envPath, content, workspaces, defaultWorkspace.id);
    } catch (error) {
      if (queuedEvent) {
        try {
          acknowledgeConfigEvents(eventQueuePath, [queuedEvent.id]);
        } catch {
          // 保留原始配置写入错误；无效事件不会在 Workspace 生效前被消费。
        }
      }
      throw error;
    }
    if (eventQueuePath && removedWorkspaces.length > 0) {
      discardWorkspaceConfigEvents(
        eventQueuePath,
        removedWorkspaces.map((removed) => removed.id),
      );
    }
  }
  return {
    added,
    workspace,
    defaultWorkspace,
    defaultChanged,
    removedWorkspaces,
  };
}

export function removeWorkspaceFromEnv({
  envPath,
  selector,
  fallbackDefaultWorkspace,
  eventQueuePath,
}) {
  const content = readFileSync(envPath, "utf8");
  chmodSync(envPath, 0o600);
  const parsed = parseWorkspaceConfig(parse(content));
  const selected = resolveWorkspaceSelector(parsed.workspaces, selector);
  if (
    selected.id === fallbackDefaultWorkspace.id
    || resolve(selected.cwd) === resolve(fallbackDefaultWorkspace.cwd)
  ) {
    throw new Error("固定默认 Workspace 不能删除");
  }

  const workspaces = parsed.workspaces.filter(
    (workspace) => workspace.id !== selected.id,
  );
  let defaultWorkspace = workspaces.find(
    (workspace) => workspace.id === parsed.defaultWorkspaceId,
  );
  if (!defaultWorkspace) {
    const fallback = ensureFallbackWorkspace(fallbackDefaultWorkspace);
    defaultWorkspace = upsertFallbackWorkspace(workspaces, fallback);
  }
  if (eventQueuePath) {
    readConfigEvents(eventQueuePath);
  }
  writeWorkspaceConfig(envPath, content, workspaces, defaultWorkspace.id);
  if (eventQueuePath) {
    discardWorkspaceConfigEvents(eventQueuePath, [selected.id]);
  }
  return {
    removedWorkspace: selected,
    defaultWorkspace,
    defaultChanged: defaultWorkspace.id !== parsed.defaultWorkspaceId,
  };
}

function appendWorkspace(workspaces, { cwd, id, name }) {
  const workspaceName = normalizedName(name ?? basename(cwd));
  const baseId = normalizedId(id ?? workspaceName);
  let workspaceId = baseId;
  let suffix = 2;
  const usedIds = new Set(workspaces.map((workspace) => workspace.id));
  while (usedIds.has(workspaceId)) {
    workspaceId = `${baseId.slice(0, Math.max(1, 63 - String(suffix).length - 1))}-${suffix}`;
    suffix += 1;
  }
  const workspace = { id: workspaceId, name: workspaceName, cwd };
  workspaces.push(workspace);
  return workspace;
}

function upsertFallbackWorkspace(workspaces, fallback) {
  const retained = workspaces.filter(
    (workspace) => workspace.id !== fallback.id && workspace.cwd !== fallback.cwd,
  );
  workspaces.splice(0, workspaces.length, { ...fallback }, ...retained);
  return workspaces[0];
}

function ensureFallbackWorkspace(workspace) {
  try {
    mkdirSync(workspace.cwd, { recursive: true, mode: 0o700 });
    chmodSync(workspace.cwd, 0o700);
  } catch {
    throw new Error(`无法恢复默认 Workspace 目录：${workspace.cwd}`);
  }
  const directory = inspectWorkspaceDirectory(workspace.cwd);
  if (!directory.valid) {
    throw new Error(`无法恢复默认 Workspace 目录：${workspace.cwd}`);
  }
  return {
    cwd: directory.cwd,
    id: workspace.id,
    name: workspace.name,
  };
}

function resolveWorkspaceSelector(workspaces, selector) {
  const normalized = String(selector ?? "").trim();
  if (!normalized) {
    throw new Error("需要提供 Workspace 序号、ID 或名称");
  }
  if (/^\d+$/.test(normalized)) {
    const workspace = workspaces[Number(normalized) - 1];
    if (workspace) {
      return workspace;
    }
  }
  const matches = workspaces.filter(
    (workspace) => workspace.id === normalized || workspace.name === normalized,
  );
  if (matches.length === 1) {
    return matches[0];
  }
  throw new Error(matches.length > 1 ? "Workspace 选择不唯一" : "找不到指定 Workspace");
}

function writeWorkspaceConfig(envPath, content, workspaces, defaultWorkspaceId) {
  const json = JSON.stringify(workspaces).replaceAll("'", "\\u0027");
  let updated = setEnvValue(content, "CODEX_WORKSPACES_JSON", `'${json}'`);
  updated = setEnvValue(updated, "CODEX_DEFAULT_WORKSPACE", defaultWorkspaceId);
  const temporaryPath = `${envPath}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, updated, { mode: 0o600 });
  renameSync(temporaryPath, envPath);
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
