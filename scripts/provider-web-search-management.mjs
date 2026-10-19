import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { join } from "node:path";
import { parse, stringify } from "smol-toml";
import { codexHomePath } from "../runtime/codex-home.mjs";
import { loadManagedModelProviderDefinitions } from "../runtime/model-provider-definitions.mjs";
import { customPrimaryProviderProfilePath } from "../runtime/model-provider-runtime.mjs";
import { decodeProviderWebSearchSettings, isProviderWebSearchId, providerWebSearchSettingsPath, readProviderWebSearchOverride } from "../runtime/provider-web-search.mjs";
import { configuredWebSearchProviders, loadModelProviderManagementState } from "./model-provider-management.mjs";
import { applyProviderFileUpdates, assertProviderFileSnapshots, snapshotProviderFiles } from "./managed-provider-files.mjs";
import { withModelProviderManagementTransaction } from "./model-provider-management-transaction.mjs";

const revisionSecret = randomBytes(32);
const modes = new Set([null, "disabled", "cached", "indexed", "live"]);

export class ProviderWebSearchManagementError extends Error {
  constructor(code, field, message, options) {
    super(message, options);
    this.name = "ProviderWebSearchManagementError";
    this.code = code;
    this.field = field;
  }
}

export async function previewProviderWebSearchChange(input, options = {}) {
  try { return (await buildPlan(input, options)).preview; }
  catch (error) { throw stateError(error); }
}

export async function applyProviderWebSearchChange(input, options = {}) {
  const environment = options.environment ?? process.env;
  return withModelProviderManagementTransaction(environment, async () => {
    let plan;
    try { plan = await buildPlan(input, options); }
    catch (error) { throw stateError(error); }
    if (!options.preview || !isDeepStrictEqual(options.preview, plan.preview)) {
      throw invalid("stale-preview", "resourceRevision", "Provider 或搜索设置已变化，请重新预览并确认");
    }
    if (!plan.preview.willChange) return { ...plan.preview, action: "unchanged" };
    // A crash between these files leaves a marker; runtime readers fail closed.
    const transactionId = randomUUID();
    const backups = plan.snapshots.filter(snapshot => plan.updates.has(snapshot.path) && snapshot.content !== undefined)
      .map(snapshot => ({ sourcePath: snapshot.path, path: `${snapshot.path}.search-backup-${transactionId}`, content: snapshot.content }));
    const snapshots = [...plan.snapshots, ...snapshotProviderFiles(backups.map(backup => backup.path), environment)];
    if (snapshots.some(snapshot => backups.some(backup => backup.path === snapshot.path) && snapshot.content !== undefined)) {
      throw invalid("write-failed", "mode", "Provider 搜索设置备份版本已存在，拒绝覆盖");
    }
    const pendingContent = stringify({ version: 1, provider: input.provider, transactionId,
      backups: backups.map(backup => backup.path),
      files: [...plan.updates].map(([path, content]) => {
        const backup = backups.find(candidate => candidate.sourcePath === path);
        return { path, existed: plan.snapshots.find(snapshot => snapshot.path === path).content !== undefined,
          expectedSha256: createHash("sha256").update(content).digest("hex"),
          ...(backup === undefined ? {} : { backup: backup.path }) };
      }) });
    const updates = new Map([[plan.pendingPath, pendingContent], ...backups.map(backup => [backup.path, backup.content]), ...plan.updates]);
    try { await applyProviderFileUpdates(updates, snapshots); }
    catch (error) {
      throw invalid("write-failed", "mode", "Provider 搜索设置写入未完成，请核对当前文件及备份后处理", error);
    }
    try {
      for (const [path, expected] of updates) {
        const [saved] = snapshotProviderFiles([path], environment);
        if (!saved.content?.equals(Buffer.from(expected))) throw new Error("搜索设置、Profile 或备份回读不一致");
      }
      // Verify all original and written guards before completing the transaction.
      const guards = snapshots.map(snapshot => updates.has(snapshot.path)
        ? { ...snapshot, content: Buffer.from(updates.get(snapshot.path)) } : snapshot);
      await assertProviderFileSnapshots(guards);
      await guards.find(snapshot => snapshot.path === plan.pendingPath).writeCurrent(undefined);
      if (readProviderWebSearchOverride(input.provider, environment) !== input.mode) throw new Error("搜索设置回读不一致");
    } catch (error) {
      throw invalid("save-unconfirmed", "mode", "Provider 搜索设置保存结果无法确认，已保留当前文件及备份；请核对后处理，勿自动重试", error);
    }
    return { ...plan.preview, action: "updated" };
  });
}

async function buildPlan(input, { environment = process.env, loadProviderState = loadModelProviderManagementState } = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)
    || Object.keys(input).some(key => !["provider", "mode", "resourceRevision"].includes(key))
    || !isProviderWebSearchId(input.provider) || !modes.has(input.mode)
    || typeof input.resourceRevision !== "string" || !/^[a-f0-9]{64}$/u.test(input.resourceRevision)) {
    throw invalid("invalid-input", "mode", "Provider 搜索设置参数无效；请选择精确 Provider 与支持的模式");
  }
  const path = providerWebSearchSettingsPath(environment);
  const pendingPath = `${path}.pending`;
  // This also rejects incomplete transactions before reading or modifying profiles.
  readProviderWebSearchOverride(input.provider, environment);
  const [snapshot, pendingSnapshot] = snapshotProviderFiles([path, pendingPath], environment);
  if (pendingSnapshot.content !== undefined) throw invalid("provider-state-unavailable", "mode", "Provider 搜索设置存在未完成保存记录，请先核对备份");
  const document = decodeProviderWebSearchSettings(snapshot.content?.toString("utf8"));
  const state = await loadProviderState({ environment });
  if (!configuredWebSearchProviders(state).includes(input.provider)) {
    throw invalid("provider-not-configured", "provider", "Provider 未配置；聚合 Provider 不支持独立搜索设置");
  }
  const snapshots = [snapshot, pendingSnapshot];
  const definition = state.managedProviders.some(provider => provider.id === input.provider)
    ? loadManagedModelProviderDefinitions(environment).find(provider => provider.id === input.provider) : undefined;
  if (state.managedProviders.some(provider => provider.id === input.provider) && definition === undefined) {
    throw invalid("stale-preview", "provider", "受管 Provider 注册表已变化，请重新读取并预览");
  }
  const profilePath = definition ? join(codexHomePath(environment), definition.profileFileName)
    : state.customProviders.switchingProviders.some(provider => provider.id === input.provider)
      ? customPrimaryProviderProfilePath(environment, input.provider) : undefined;
  const updates = new Map();
  let clearsProfileOverride = false;
  if (profilePath !== undefined) {
    const [profileSnapshot] = snapshotProviderFiles([profilePath], environment);
    snapshots.push(profileSnapshot);
    if (profileSnapshot.content !== undefined) {
      let profile;
      try { profile = parse(profileSnapshot.content.toString("utf8")); }
      catch { throw invalid("provider-state-unavailable", "provider", "Provider Profile 无法安全解析，未执行搜索设置保存"); }
      if (Object.hasOwn(profile, "web_search")) {
        delete profile.web_search;
        updates.set(profilePath, stringify(profile));
        clearsProfileOverride = true;
      }
    }
  }
  await assertProviderFileSnapshots(snapshots);
  const before = readProviderWebSearchOverride(input.provider, environment);
  await assertProviderFileSnapshots(snapshots);
  const providers = { ...document.providers };
  if (input.mode === null) delete providers[input.provider];
  else Object.defineProperty(providers, input.provider, { value: input.mode, enumerable: true, configurable: true, writable: true });
  const content = stringify({ version: 1, providers });
  if (Buffer.byteLength(content, "utf8") > 1_048_576) throw invalid("invalid-input", "mode", "Provider 搜索设置超过大小上限");
  updates.set(path, content);
  const revision = createHmac("sha256", revisionSecret).update(JSON.stringify([
    input, state, snapshots.map(snapshot => [snapshot.path, snapshot.content?.toString("utf8") ?? null]),
  ])).digest("hex");
  return { path, pendingPath, snapshots, updates, preview: { operation: "provider.web-search", provider: input.provider,
    before: { mode: before }, mode: input.mode, revision, willChange: before !== input.mode || clearsProfileOverride,
    effects: { clearsProfileOverride }, activation: "restart-app-server" } };
}

function invalid(code, field, message, cause) {
  return new ProviderWebSearchManagementError(code, field, message, cause === undefined ? undefined : { cause });
}

function stateError(error) {
  return error instanceof ProviderWebSearchManagementError ? error
    : invalid("provider-state-unavailable", "provider", "Provider 或独立搜索设置无法安全读取，未执行写入", error);
}
