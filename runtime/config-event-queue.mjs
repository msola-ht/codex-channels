import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

const queueVersion = 1;
const maximumEvents = 100;
const maximumQueueBytes = 256 * 1024;
const lockTimeoutMs = 2_000;
const staleLockMs = 30_000;

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
  withQueueLock(queuePath, () => {
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
  });
  return event;
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

export function discardWorkspaceConfigEvents(queuePath, workspaceIds) {
  const discarded = new Set(workspaceIds);
  if (discarded.size === 0 || !existsSync(queuePath)) {
    return;
  }
  withQueueLock(queuePath, () => {
    const retained = readQueueUnlocked(queuePath).filter(
      (event) => !discarded.has(event.workspace.id),
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
  chmodSync(queuePath, 0o600);
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
  renameSync(temporaryPath, queuePath);
}

function serializeQueue(events) {
  return `${JSON.stringify({ version: queueVersion, events })}\n`;
}

function ensureQueueDirectory(queuePath) {
  const directory = dirname(queuePath);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
}

function withQueueLock(queuePath, operation) {
  ensureQueueDirectory(queuePath);
  const lockPath = `${queuePath}.lock`;
  const startedAt = Date.now();
  let descriptor;
  while (descriptor === undefined) {
    try {
      descriptor = openSync(lockPath, "wx", 0o600);
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }
      if (isStaleLock(lockPath)) {
        try {
          unlinkSync(lockPath);
          continue;
        } catch (unlinkError) {
          if (unlinkError?.code !== "ENOENT") {
            throw unlinkError;
          }
        }
      }
      if (Date.now() - startedAt >= lockTimeoutMs) {
        throw new Error("配置事件队列正被其他进程使用，请稍后重试");
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  try {
    return operation();
  } finally {
    closeSync(descriptor);
    try {
      unlinkSync(lockPath);
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }
  }
}

function isStaleLock(lockPath) {
  try {
    return Date.now() - statSync(lockPath).mtimeMs > staleLockMs;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}
