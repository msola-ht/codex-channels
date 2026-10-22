import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

import {
  securePrivateDirectorySync,
  securePrivateFileSync,
} from "./private-file.mjs";
import {
  PrivateDirectoryLockReleaseError,
  withPrivateDirectoryLockSync,
} from "./private-directory-lock.mjs";

const queueVersion = 1;
const maximumEvents = 100;
const maximumQueueBytes = 256 * 1024;

export class ConfigEventQueueLockReleaseError extends Error {
  constructor(result, cause) {
    super("配置事件队列操作已完成，但锁释放失败", { cause });
    this.name = "ConfigEventQueueLockReleaseError";
    Object.defineProperty(this, "result", { value: result });
  }
}

export function configEventQueuePath(dataDir) {
  return join(dataDir, "data", "config-events.json");
}

export function enqueueWorkspaceAdded(queuePath, workspace) {
  const event = {
    version: queueVersion,
    id: randomUUID(),
    type: "workspace-added",
    createdAt: new Date().toISOString(),
    workspace: normalizedWorkspace(workspace),
  };
  return withQueueLock(queuePath, () => {
    const events = readQueueUnlocked(queuePath);
    if (events.length >= maximumEvents) {
      throw new Error(`配置事件队列已满（最多 ${maximumEvents} 条），请确认 Gateway 正常运行`);
    }
    const updated = [...events, event];
    const content = serializeQueue(updated);
    if (Buffer.byteLength(content) > maximumQueueBytes) {
      throw new Error("配置事件队列超过 256 KiB，请确认 Gateway 正常运行");
    }
    writeQueueUnlocked(queuePath, updated);
    return event;
  });
}

export function readConfigEvents(queuePath) {
  return withQueueLock(queuePath, () => readQueueUnlocked(queuePath));
}

export function matchingWorkspaceConfigEvents(events, workspaces) {
  return events.filter((event) => {
    const workspace = workspaces.find((candidate) => candidate.id === event.workspace.id);
    return workspace !== undefined
      && workspace.name === event.workspace.name
      && workspace.cwd === event.workspace.cwd;
  });
}

export function acknowledgeConfigEvents(queuePath, eventIds) {
  const acknowledged = new Set(eventIds);
  if (acknowledged.size === 0) {
    return;
  }
  withQueueLock(queuePath, () => {
    const retained = readQueueUnlocked(queuePath).filter(
      (event) => !acknowledged.has(event.id),
    );
    writeQueueUnlocked(queuePath, retained);
  });
}

function readQueueUnlocked(queuePath) {
  if (!existsSync(queuePath)) {
    return [];
  }
  if (statSync(queuePath).size > maximumQueueBytes) {
    throw new Error("配置事件队列超过 256 KiB");
  }
  securePrivateFileSync(queuePath);
  const content = readFileSync(queuePath, "utf8");
  if (!content.trim()) {
    return [];
  }
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error("配置事件队列不是有效 JSON");
  }
  if (!parsed || typeof parsed !== "object" || parsed.version !== queueVersion || !Array.isArray(parsed.events)) {
    throw new Error("配置事件队列格式无效");
  }
  const events = parsed.events.map((event, index) => parseEvent(event, index + 1));
  if (events.length > maximumEvents) {
    throw new Error(`配置事件队列超过 ${maximumEvents} 条`);
  }
  return events;
}

function parseEvent(value, index) {
  if (
    !value
    || typeof value !== "object"
    || value.version !== queueVersion
    || typeof value.id !== "string"
    || !/^[0-9a-f-]{36}$/.test(value.id)
    || value.type !== "workspace-added"
    || typeof value.createdAt !== "string"
  ) {
    throw new Error(`配置事件队列第 ${index} 条格式无效`);
  }
  return {
    version: queueVersion,
    id: value.id,
    type: value.type,
    createdAt: value.createdAt,
    workspace: normalizedWorkspace(value.workspace),
  };
}

function normalizedWorkspace(workspace) {
  if (!workspace || typeof workspace !== "object") {
    throw new Error("配置事件缺少 Workspace");
  }
  const id = String(workspace.id ?? "").trim();
  const name = String(workspace.name ?? "").trim();
  const cwd = String(workspace.cwd ?? "").trim();
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id) || !name || name.length > 64 || !cwd) {
    throw new Error("配置事件包含无效 Workspace");
  }
  return { id, name, cwd };
}

function writeQueueUnlocked(queuePath, events) {
  ensureQueueDirectory(queuePath);
  const temporaryPath = `${queuePath}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, serializeQueue(events), { mode: 0o600 });
  securePrivateFileSync(temporaryPath);
  renameSync(temporaryPath, queuePath);
}

function serializeQueue(events) {
  return `${JSON.stringify({ version: queueVersion, events })}\n`;
}

function ensureQueueDirectory(queuePath) {
  const directory = dirname(queuePath);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  securePrivateDirectorySync(directory);
}

function withQueueLock(queuePath, operation) {
  ensureQueueDirectory(queuePath);
  try {
    return withPrivateDirectoryLockSync(`${queuePath}.lock`, operation);
  } catch (error) {
    if (error instanceof PrivateDirectoryLockReleaseError) {
      throw new ConfigEventQueueLockReleaseError(error.result, error);
    }
    throw error;
  }
}
