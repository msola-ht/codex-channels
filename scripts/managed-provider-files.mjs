import { unlinkSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { parse } from "smol-toml";

import { codexHomePath } from "../runtime/codex-home.mjs";
import { assertCodexConfigHasNoPlaintextCredentials, createProviderFileAccess, createProviderFileReader } from "../runtime/provider-file-access.mjs";
import { managedPrimaryCredentialPath } from "../runtime/managed-provider-credentials.mjs";
import { createCodexUserConfigClient, withCodexUserConfigClient } from "./codex-user-config.mjs";

const maximumPrivateConfigBytes = 2_097_152;

/** Stage immutable credentials before publishing the main config, within its rollback transaction. */
export function stageManagedPrimaryCredential(credential, definition, environment, snapshots, updates) {
  if (credential === undefined) return;
  const path = managedPrimaryCredentialPath(environment, definition, credential.environmentKey);
  const [snapshot] = snapshotProviderFiles([path], environment);
  if (snapshot.content !== undefined) throw new Error("受管主 Provider 凭据版本已存在，拒绝覆盖");
  snapshots.push(snapshot);
  const previous = [...updates];
  updates.clear();
  updates.set(path, credential.content);
  for (const [previousPath, content] of previous) updates.set(previousPath, content);
}

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
  if (createProviderFileAccess(environment).isMainConfig(path)) {
    throw new Error("Codex 主配置必须通过事务快照的版本化字段编辑写入");
  }
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
  const { read, write, isMainConfig } = createProviderFileAccess(environment);
  return [...new Set(paths)].map((path) => {
    const readFile = () => readOptionalFile(read, path);
    const originalContent = readFile();
    const state = { content: originalContent, originalContent, uncertain: false };
    const readCurrent = () => {
      if (state.uncertain) throw new Error("Codex 主配置保存结果无法确认；已保留私有文件、凭据及备份，请先核对主配置，勿自动重试或恢复备份");
      return readFile();
    };
    const writeCurrent = isMainConfig(path)
      ? content => writeMainConfigEdits(content, state, readFile, environment)
      : content => content === undefined ? removeOptionalProviderFile(path) : write(path, content);
    return { path, content: readCurrent(), readCurrent, writeCurrent };
  });
}

/** The upstream writer owns version checking and field persistence; never replace its file. */
async function writeMainConfigEdits(content, state, readFile, environment) {
  if (state.uncertain) throw new Error("Codex 主配置存在未确认写入，拒绝自动重放");
  const before = parseMainConfig(state.content);
  const after = parseMainConfig(content);
  assertCodexConfigHasNoPlaintextCredentials(content ?? "");
  // A rollback reverses only our published fields, including when readback saw
  // an unrelated upstream edit. Never turn the old full snapshot into a restore.
  const plannedChanges = state.reverseChanges && isDeepStrictEqual(after, parseMainConfig(state.originalContent))
    ? state.reverseChanges : configChanges(before, after);
  // This is the sole path field edited by managed-account main-config plans.
  // RPC validation requires an absolute value, including a restored catalog.
  const changes = plannedChanges.map(change => change.segments.length === 1
    && change.segments[0] === "model_catalog_json" && typeof change.value === "string"
    ? { ...change, value: mainCatalogPath(change.value, environment) } : change);
  if (changes.length === 0) return;
  await withCodexUserConfigClient(environment, createCodexUserConfigClient, undefined, async client => {
    if (!sameOptionalContent(readFile(), state.content)) {
      throw new Error("Codex 主配置已变化，请重新预览并确认");
    }
    const current = await client.readUserConfigSnapshot();
    // config/read resolves relative paths. Bind its version to a stable raw
    // snapshot instead of comparing normalized RPC values with TOML literals.
    if (!sameOptionalContent(readFile(), state.content)) {
      throw new Error("Codex 主配置已变化，请重新预览并确认");
    }
    let writeError;
    try {
      await client.writeUserConfigEdits(changes.map(({ segments, value }) => ({
        keyPath: segments.map(segment => JSON.stringify(segment)).join("."), value,
      })), { expectedVersion: current.version });
    } catch (error) { writeError = error; }
    try {
      // A response alone does not prove the multi-file publication succeeded.
      const observed = readFile();
      await client.readUserConfigSnapshot();
      const actual = readFile();
      if (!sameOptionalContent(observed, actual)) {
        throw new Error("Codex 主配置回读期间发生变化");
      }
      const saved = parseMainConfig(actual);
      if (changes.every(({ segments, value }) => isDeepStrictEqual(configAt(saved, segments), value === null ? undefined : value))) {
        state.content = actual;
        state.reverseChanges = changes.map(({ segments }) => ({ segments, value: configAt(before, segments) ?? null }));
        return;
      }
      if (writeError && isDeepStrictEqual(saved, before)) throw writeError;
      state.uncertain = true;
      throw new Error("Codex 主配置字段保存结果不一致；已保留私有文件、凭据及备份，请先核对后再操作");
    } catch (error) {
      if (error === writeError) throw error;
      state.uncertain = true;
      throw new AggregateError([...(writeError ? [writeError] : []), error],
        "Codex 主配置保存结果无法确认；已保留私有文件、凭据及备份，未自动回滚或重试", { cause: error });
    }
  }, { preserveOperationResult: true });
}

function mainCatalogPath(value, environment) {
  // Match the locked CLI's home-relative forms; ~user remains an ordinary path.
  const suffix = value === "~" ? "" : value.startsWith("~/") ? value.slice(2).replace(/^\/+/u, "")
    : process.platform === "win32" && value.startsWith("~\\") ? value.slice(2).replace(/^\\+/u, "") : null;
  if (suffix !== null) {
    const home = (process.platform === "win32" ? environment.USERPROFILE : environment.HOME) || homedir();
    return resolve(home, suffix);
  }
  return resolve(codexHomePath(environment), value);
}

function parseMainConfig(content) {
  try { return content === undefined ? {} : parse(Buffer.from(content).toString("utf8")); }
  catch { throw new Error("Codex 主配置无法安全解析，未执行写入"); }
}

function configChanges(before, after, segments = []) {
  if (isDeepStrictEqual(before, after)) return [];
  // A removed Provider/Profile entry must disappear as a unit: clearing its
  // leaves would leave an empty, invalid Provider. Its inverse uses the same
  // entry boundary when publishing a new Provider. Keep the parent collection.
  if (after === undefined && segments.length >= 2) return [{ segments, value: null }];
  if (before === undefined && segments.length >= 2) return [{ segments, value: after }];
  const table = value => value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
  if ((before === undefined || table(before)) && (after === undefined || table(after))) {
    const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
    if (keys.size > 0) return [...keys].flatMap(key => configChanges(before?.[key], after?.[key], [...segments, key]));
  }
  return [{ segments, value: after ?? null }];
}

function configAt(config, segments) {
  let value = config;
  for (const segment of segments) value = value?.[segment];
  return value;
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
  // Restore references before deleting newly created credentials. A partial rollback keeps recovery material.
  const restores = snapshots.filter(snapshot => snapshot.content !== undefined);
  const removals = snapshots.filter(snapshot => snapshot.content === undefined);
  for (const snapshot of restores) {
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
  for (const snapshot of removals) {
    try {
      const guard = guards.find(item => item.path === snapshot.path);
      if (!guard) throw new Error(`第三方 Provider 配置缺少事务快照：${snapshot.path}`);
      if (!sameOptionalContent(snapshot.content, guard.content)) await snapshot.writeCurrent(undefined);
    } catch (error) { errors.push(error); break; }
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
