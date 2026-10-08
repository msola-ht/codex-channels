import { unlinkSync } from "node:fs";

import { createProviderFileAccess, createProviderFileReader } from "../runtime/provider-file-access.mjs";

const maximumPrivateConfigBytes = 2_097_152;

export async function readOptionalProviderFile(path, environment) {
  return readOptionalFile(createProviderFileReader(environment), path);
}

function readOptionalFile(read, path) {
  try {
    return Buffer.from(read(path, maximumPrivateConfigBytes));
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

export async function replaceOptionalProviderFile(path, content, environment) {
  if (content === undefined) return removeOptionalProviderFile(path);
  await createProviderFileAccess(environment).write(path, content);
}

export async function removeOptionalProviderFile(path) {
  try {
    unlinkSync(path);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

export function snapshotProviderFiles(paths, environment) {
  const { read, write } = createProviderFileAccess(environment);
  return [...new Set(paths)].map((path) => {
    const readCurrent = () => readOptionalFile(read, path);
    const writeCurrent = content => content === undefined ? removeOptionalProviderFile(path) : write(path, content);
    return { path, content: readCurrent(), readCurrent, writeCurrent };
  });
}

export async function assertProviderFileSnapshots(snapshots) {
  for (const snapshot of snapshots) {
    const current = snapshot.readCurrent();
    if (!sameOptionalContent(current, snapshot.content)) {
      throw new Error(`第三方 Provider 配置文件在事务期间发生变化：${snapshot.path}`);
    }
  }
}

export function refreshProviderFileSnapshot(snapshots, path) {
  return snapshots.map((snapshot) => snapshot.path === path
    ? { ...snapshot, content: snapshot.readCurrent() }
    : snapshot);
}

export async function restoreProviderFileSnapshots(snapshots, guards) {
  await assertProviderFileSnapshots(guards);
  const errors = [];
  for (const snapshot of snapshots) {
    try {
      const guard = guards.find((item) => item.path === snapshot.path);
      if (!guard) throw new Error(`第三方 Provider 配置缺少事务快照：${snapshot.path}`);
      if (!sameOptionalContent(snapshot.content, guard.content)) {
        await snapshot.writeCurrent(snapshot.content);
      }
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) throw new AggregateError(errors, "第三方 Provider 配置文件回滚未完成");
}

export async function applyProviderFileUpdates(updates, snapshots) {
  let guards = snapshots;
  try {
    for (const [path, content] of updates) {
      await assertProviderFileSnapshots(guards);
      const snapshot = guards.find(item => item.path === path);
      if (!snapshot) throw new Error(`第三方 Provider 配置缺少事务快照：${path}`);
      await snapshot.writeCurrent(content);
      guards = refreshProviderFileSnapshot(guards, path);
    }
  } catch (error) {
    try {
      await restoreProviderFileSnapshots(snapshots, guards);
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], "第三方 Provider 配置失败且回滚未完成", {
        cause: rollbackError,
      });
    }
    throw error;
  }
}

function sameOptionalContent(left, right) {
  if (left === undefined || right === undefined) return left === right;
  return left.equals(right);
}
