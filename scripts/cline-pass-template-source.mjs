import { lstatSync } from "node:fs";
import { dirname, join } from "node:path";
import { providerStorageRoot } from "../runtime/connect-home.mjs";
import { assertPrivateDirectoryAccessSync, ensurePrivateDirectorySync } from "../runtime/private-file.mjs";
import { clineRelayCatalogSchema } from "../runtime/cline-relay-catalog.mjs";
import { downloadClineRelayCatalog } from "../runtime/cline-relay-catalog-update.mjs";
import { applyProviderFileUpdates, assertProviderFileSnapshots, snapshotProviderFiles } from "./managed-provider-files.mjs";
import { withModelProviderManagementTransaction } from "./model-provider-management-transaction.mjs";

const maximumBytes = 1024 * 1024;
export const clinePassTemplateSourcePath = (environment = process.env) =>
  join(providerStorageRoot(environment), "clp", "template-source.json");

function sourceDirectories(environment) {
  return [providerStorageRoot(environment), dirname(clinePassTemplateSourcePath(environment))];
}

function assertSourceDirectories(environment) {
  for (const path of sourceDirectories(environment)) {
    const metadata = lstatSync(path);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()
      || process.platform !== "win32" && ((metadata.mode & 0o077) !== 0
        || process.getuid !== undefined && metadata.uid !== process.getuid())) {
      throw new Error("CLP 模板来源目录权限、类型或所有者无效");
    }
    assertPrivateDirectoryAccessSync(path);
  }
}

function captureSourceFiles(paths, environment) {
  assertSourceDirectories(environment);
  return snapshotProviderFiles(paths, environment).map(snapshot => ({ ...snapshot,
    readCurrent: () => { assertSourceDirectories(environment); return snapshot.readCurrent(); },
    writeCurrent: content => { assertSourceDirectories(environment); return snapshot.writeCurrent(content); },
  }));
}

/** A source snapshot only; never used as the live Codex or Relay model catalog. */
export function readClinePassTemplateSource(environment = process.env) {
  return readClinePassTemplateSourceSnapshot(environment).catalog;
}

/** Parse the same captured bytes that callers bind into their revision and guards. */
export function readClinePassTemplateSourceSnapshot(environment = process.env) {
  const [snapshot] = captureSourceFiles([clinePassTemplateSourcePath(environment)], environment);
  if (snapshot.content === undefined || snapshot.content.length > maximumBytes) {
    throw new Error("CLP 模板来源缺失或超过 1 MiB");
  }
  return { snapshot, catalog: clineRelayCatalogSchema.parse(JSON.parse(snapshot.content.toString("utf8"))) };
}

export async function refreshClinePassTemplateSource({ environment = process.env, signal } = {}) {
  const timeout = globalThis.AbortSignal.timeout(25_000);
  const operationSignal = signal ? globalThis.AbortSignal.any([signal, timeout]) : timeout;
  operationSignal.throwIfAborted();
  for (const directory of sourceDirectories(environment)) ensurePrivateDirectorySync(directory);
  const path = clinePassTemplateSourcePath(environment);
  const snapshots = captureSourceFiles([path, `${path}.backup`], environment);
  const catalog = clineRelayCatalogSchema.parse(await downloadClineRelayCatalog(environment, operationSignal));
  const content = `${JSON.stringify(catalog, null, 2)}\n`;
  if (Buffer.byteLength(content) > maximumBytes) throw new Error("CLP 模板来源超过 1 MiB，原缓存保留");
  return withModelProviderManagementTransaction(environment, async () => {
    operationSignal.throwIfAborted();
    await assertProviderFileSnapshots(snapshots);
    const updates = new Map();
    if (snapshots[0].content !== undefined) updates.set(`${path}.backup`, snapshots[0].content);
    updates.set(path, content);
    await applyProviderFileUpdates(updates, snapshots);
    if (JSON.stringify(readClinePassTemplateSource(environment)) !== JSON.stringify(catalog)) {
      throw new Error("CLP 模板来源回读不一致，请核对缓存与备份后重新刷新");
    }
    return { action: "refreshed", path, commit: catalog.commit, downloadedAt: catalog.downloadedAt, models: catalog.models.length };
  });
}

export async function runClinePassTemplateSourceRefresh({ environment = process.env, output = process.stdout } = {}) {
  output.write("正在联网刷新 CLP 模板来源……\n");
  const result = await refreshClinePassTemplateSource({ environment });
  output.write(`已保存 ${result.models} 个模型的来源信息：${result.path}\n来源提交：${result.commit}\n下载时间：${new Date(result.downloadedAt).toISOString()}\n已有模型未修改；请在模型管理中预览并应用模板更新。\n`);
  return result;
}
