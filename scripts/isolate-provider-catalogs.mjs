import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parse, stringify } from "smol-toml";
import { providerStorageRoot } from "../runtime/connect-home.mjs";
import { codexHomePath } from "../runtime/codex-home.mjs";
import { managedProviderAccountFamilies, loadManagedModelProviderDefinitions } from "../runtime/model-provider-definitions.mjs";
import { managedProviderDirectory, managedProviderMarkerPath } from "../runtime/model-provider-runtime.mjs";
import { responsesContextSyncPath } from "../runtime/model-provider-responses-catalog.mjs";
import { providerCatalogIsolationPath } from "../runtime/provider-catalog-isolation.mjs";
import { readPrivateFileSync, writePrivateFileAtomic } from "../runtime/private-file.mjs";
import { createProviderFileAccess } from "../runtime/provider-file-access.mjs";
import { withModelProviderManagementTransaction } from "./model-provider-management-transaction.mjs";
import { snapshotProviderFiles, applyProviderFileUpdates } from "./managed-provider-files.mjs";
import { managedAccountPrimarySocket } from "./managed-provider-account-runtime.mjs";
import { inspectAppServerSupervisorState } from "../runtime/app-server-supervisor.mjs";

const maximumBytes = 16 * 1024 * 1024;
const encode = value => `${JSON.stringify(value, null, 2)}\n`;

function parseConfig(content) {
  try { return parse(content); } catch { throw new Error("账户配置无法安全解析，未执行目录拆分"); }
}

function materials(environment) {
  const definitions = loadManagedModelProviderDefinitions(environment).filter(definition => definition.accountId !== undefined);
  const root = providerStorageRoot(environment);
  const home = codexHomePath(environment);
  const accounts = definitions.map(definition => ({
    provider: definition.id, definition,
    marker: managedProviderMarkerPath(environment, definition),
    profile: join(home, definition.profileFileName),
    source: join(root, definition.storageId ?? definition.id, definition.catalogFileName),
    manifest: join(root, definition.storageId ?? definition.id, definition.catalogManifestFileName),
    target: join(managedProviderDirectory(environment, definition), definition.catalogFileName),
    targetManifest: join(managedProviderDirectory(environment, definition), definition.catalogManifestFileName),
  }));
  const config = join(home, "config.toml");
  const paths = [...new Set([config, ...managedProviderAccountFamilies.map(family => family.accountsFilePath(environment)),
    ...accounts.flatMap(account => [account.marker, account.profile, account.source, account.manifest, account.target, account.targetManifest])])];
  return { accounts, config, paths };
}

function buildPlan(environment, layout) {
  const snapshots = snapshotProviderFiles(layout.paths, environment);
  const original = path => snapshots.find(snapshot => snapshot.path === path)?.content?.toString("utf8");
  const updates = new Map();
  const providers = [];
  const references = new Map();
  for (const account of layout.accounts) {
    const markerText = original(account.marker);
    if (markerText === undefined) throw new Error(`账户 ${account.provider} 缺少管理标记`);
    const marker = parseConfig(markerText);
    if (!["switching", "exclusive"].includes(marker.mode)) throw new Error(`账户 ${account.provider} 模式无效`);
    const reference = marker.mode === "exclusive" ? layout.config : account.profile;
    const referenceText = original(reference);
    if (referenceText === undefined) throw new Error(`账户 ${account.provider} 缺少引用配置`);
    const document = parseConfig(referenceText);
    if (document.model_provider !== account.provider) throw new Error(`账户 ${account.provider} 的配置归属不一致`);
    if (document.model_catalog_json === account.target) {
      if (original(account.target) === undefined || original(account.targetManifest) === undefined) throw new Error(`账户 ${account.provider} 独立目录不完整`);
      continue;
    }
    if (document.model_catalog_json !== account.source) throw new Error(`账户 ${account.provider} 引用了非预期模型目录，拒绝拆分`);
    if (original(account.target) !== undefined || original(account.targetManifest) !== undefined) throw new Error(`账户 ${account.provider} 目标目录已存在，拒绝覆盖`);
    const source = original(account.source), manifest = original(account.manifest);
    if (source === undefined || manifest === undefined) throw new Error(`账户 ${account.provider} 原模型目录或来源文件缺失`);
    let catalog;
    try { catalog = JSON.parse(source); JSON.parse(manifest); } catch { throw new Error(`账户 ${account.provider} 原目录无法安全解析`); }
    const selected = catalog.models?.filter(model => model.slug === document.model);
    if (selected?.length !== 1) throw new Error(`账户 ${account.provider} 默认模型缺失或重复`);
    updates.set(account.target, source);
    updates.set(account.targetManifest, manifest);
    document.model_catalog_json = account.target;
    references.set(reference, stringify(document));
    providers.push(account.provider);
  }
  for (const [path, content] of references) updates.set(path, content);
  return { providers, files: snapshots.map(snapshot => ({ path: snapshot.path,
    previous: snapshot.content?.toString("utf8") ?? null,
    next: updates.get(snapshot.path) ?? snapshot.content?.toString("utf8") ?? null,
  })), order: [...updates.keys()] };
}

function readJournal(path, layout) {
  let journal;
  try { journal = JSON.parse(readPrivateFileSync(path, maximumBytes)); } catch { throw new Error("目录拆分恢复记录无法安全读取"); }
  if (journal?.schemaVersion !== 1 || !Array.isArray(journal.files) || !Array.isArray(journal.order)
    || !Array.isArray(journal.providers)) throw new Error("目录拆分恢复记录格式无效");
  const allowed = new Set(layout.paths), seen = new Set();
  for (const file of journal.files) {
    if (!file || !allowed.has(file.path) || seen.has(file.path)
      || (file.previous !== null && typeof file.previous !== "string") || (file.next !== null && typeof file.next !== "string")) throw new Error("目录拆分恢复记录路径或内容无效");
    seen.add(file.path);
  }
  if (seen.size !== allowed.size || new Set(journal.order).size !== journal.order.length
    || journal.order.some(path => !seen.has(path))
    || journal.providers.some(provider => !layout.accounts.some(account => account.provider === provider))) throw new Error("账户清单与拆分恢复记录不一致");
  const writable = new Set(layout.accounts.flatMap(account => [account.target, account.targetManifest, account.profile]).concat(layout.config));
  if (journal.order.some(path => !writable.has(path)) || journal.files.some(file => file.previous !== file.next && !journal.order.includes(file.path))) throw new Error("拆分恢复记录包含非目标文件写入");
  return journal;
}

function journalSnapshots(journal, environment) {
  const snapshots = snapshotProviderFiles(journal.files.map(file => file.path), environment);
  for (const file of journal.files) {
    const current = snapshots.find(snapshot => snapshot.path === file.path)?.content?.toString("utf8") ?? null;
    if (current !== file.previous && current !== file.next) throw new Error("目录拆分期间文件已修改；保留恢复记录，请先核对备份");
  }
  return snapshots;
}

async function applyJournal(journal, action, environment) {
  const snapshots = journalSnapshots(journal, environment);
  const order = action === "rollback" ? [...journal.order].reverse() : journal.order;
  const updates = new Map(order.map(path => {
    const file = journal.files.find(entry => entry.path === path);
    return [path, (action === "rollback" ? file.previous : file.next) ?? undefined];
  }));
  await applyProviderFileUpdates(updates, snapshots);
}

export async function isolateProviderCatalogs(action = "preview", environment = process.env) {
  if (!["preview", "write", "resume", "rollback"].includes(action)) throw new Error("目录拆分操作无效");
  return withModelProviderManagementTransaction(environment, async () => {
    if (existsSync(responsesContextSyncPath(environment))) throw new Error("旧上下文事务尚未恢复，请先使用 primary-provider recover 完成恢复");
    const layout = materials(environment);
    const path = providerCatalogIsolationPath(environment), backup = `${path}.backup`;
    if (["preview", "write"].includes(action) && existsSync(path)) throw new Error("已有未完成拆分，请使用 --resume 或 --rollback");
    const journal = ["resume", "rollback"].includes(action)
      ? readJournal(existsSync(path) ? path : backup, layout)
      : {schemaVersion: 1, ...buildPlan(environment, layout)};
    if (action === "preview") return {action, providers: journal.providers};
    if (action === "write" && journal.providers.length === 0) return {action: "unchanged", providers: []};
    const supervisor = await inspectAppServerSupervisorState(managedAccountPrimarySocket(environment));
    if (supervisor.status !== "missing") throw new Error("App Server 仍在运行或监管状态无法确认；请先停止整个 App Server（包括聚合实例）再拆分");
    const content = encode(journal);
    if (Buffer.byteLength(content) > maximumBytes) throw new Error("目录拆分恢复记录超过大小限制");
    if (action === "write" && existsSync(backup)) throw new Error("已有目录拆分备份，请先核对并另行归档，拒绝覆盖");
    journalSnapshots(journal, environment);
    await writePrivateFileAtomic(path, content);
    await applyJournal(journal, action, environment);
    await writePrivateFileAtomic(backup, content);
    if (createProviderFileAccess(environment).read(path, maximumBytes) !== content) throw new Error("拆分恢复记录在操作期间发生变化，未清除记录");
    // Remove only this transaction's marker after its durable backup is available.
    unlinkSync(path);
    return {action, providers: journal.providers};
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") console.log("用法：node scripts/isolate-provider-catalogs.mjs [--write|--resume|--rollback]\n默认预览；写入前须停止 App Server。复制各账户目录并保留原共享文件，私有备份支持显式恢复。");
  else if (args.length > 1 || (args.length === 1 && !["--write", "--resume", "--rollback"].includes(args[0]))) {
    console.error("不支持的参数；使用 --help 查看用法"); process.exitCode = 1;
  } else isolateProviderCatalogs(args[0]?.slice(2) ?? "preview").then(result => console.log(JSON.stringify(result))).catch(error => {
    console.error(error.message); process.exitCode = 1;
  });
}
