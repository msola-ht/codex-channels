import { recoverResponsesContextSync } from "../runtime/responses-context-sync.mjs";
import { existsSync, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { parse } from "smol-toml";

import { codexHomePath } from "../runtime/codex-home.mjs";
import { createProviderFileReader } from "../runtime/provider-file-access.mjs";
import { readPrivateFileSync, writePrivateFileAtomicSync } from "../runtime/private-file.mjs";
import { responsesProviderCatalogPath, parseResponsesModelCatalog, withResponsesModelCatalogWrite } from "../runtime/model-provider-responses-catalog.mjs";
import {
  customPrimaryProviderProfilePath,
  loadCustomSwitchingProviderIds,
  loadConfiguredCustomSwitchingModelProviders,
  loadConfiguredCustomPrimaryModelProvider,
  loadConfiguredCustomPrimaryCredential,
  readPrimaryProviderBackup,
  recoverManagedCatalogSettings,
} from "../runtime/model-provider-runtime.mjs";
import { withModelProviderManagementTransaction } from "./model-provider-management-transaction.mjs";

export async function recoverResponsesProviderCatalog(id, action, environment = process.env) {
  if (action !== "keep" && action !== "rollback") throw new Error("恢复操作必须是 keep 或 rollback");
  return withModelProviderManagementTransaction(environment, async () => {
    if (recoverResponsesContextSync(environment,id,action)) return {providerId:id,action};
    if (recoverManagedCatalogSettings(id, action, environment)) return {providerId:id,action};
    const path = responsesProviderCatalogPath(environment, id);
    let pending, pendingContent;
    try { pendingContent = readPrivateFileSync(`${path}.pending`); pending = JSON.parse(pendingContent); } catch {
      throw new Error("没有可安全读取的 Responses 目录恢复记录");
    }
    const guarded = pending?.schemaVersion === 2;
    if (guarded
      ? typeof pending.previous !== "boolean" || Object.keys(pending).length !== 4
        || (pending.previous ? typeof pending.previousDigest !== "string" || !/^[a-f0-9]{64}$/u.test(pending.previousDigest) : pending.previousDigest !== null)
        || typeof pending.nextDigest !== "string" || !/^[a-f0-9]{64}$/u.test(pending.nextDigest)
      : pending?.schemaVersion !== 1 || typeof pending.previous !== "boolean" || Object.keys(pending).length !== 2) throw new Error("Responses 目录恢复记录格式无效");
    const previous = pending.previous ? readPrivateFileSync(`${path}.backup`, 2 * 1024 * 1024) : undefined;
    const current = existsSync(path) ? readPrivateFileSync(path, 2 * 1024 * 1024) : undefined;
    const digest = value => typeof value === "string" ? createHash("sha256").update(value).digest("hex") : null;
    if (guarded && (digest(previous) !== pending.previousDigest
      || ![pending.previousDigest, pending.nextDigest].includes(digest(current)))) throw new Error("模型目录或备份存在后续修改，拒绝覆盖；请核对恢复记录");
    if (guarded && action === "keep" && digest(current) !== pending.nextDigest) throw new Error("新目录尚未完整写入，请选择 rollback");
    const candidate = action === "rollback" ? previous : current;
    if (action === "keep" && candidate === undefined) throw new Error("新目录尚未写入，请选择 rollback");
    const home = codexHomePath(environment);
    const config = readOptionalConfig(join(home, "config.toml"), environment) ?? {};
    const profile = readOptionalConfig(customPrimaryProviderProfilePath(environment, id), environment);
    const registered = loadCustomSwitchingProviderIds(environment).includes(id);
    if (registered !== (profile !== undefined)) {
      throw new Error("自定义提供商的 Profile 与注册表不一致，请先恢复对应配置");
    }
    const configured = Object.hasOwn(config.model_providers ?? {}, id);
    const backedUp = Object.hasOwn(readPrimaryProviderBackup(environment), id);
    const referenced = registered || configured || backedUp || config.model_provider === id || config.model_catalog_json === path;
    if (action === "keep" && !referenced) throw new Error("自定义提供商没有连接配置或备份，请先恢复配置或选择 rollback");
    const selection = config.model_provider === id ? config : profile;
    if (candidate === undefined && referenced) throw new Error("配置仍引用此目录，不能回滚删除；请先恢复配置");
    const assertRecoveryMaterials = expected => {
      if ((existsSync(path) ? readPrivateFileSync(path, 2 * 1024 * 1024) : undefined) !== expected
        || readPrivateFileSync(`${path}.pending`) !== pendingContent
        || (pending.previous && readPrivateFileSync(`${path}.backup`, 2 * 1024 * 1024) !== previous)) {
        throw new Error("模型目录或恢复材料已变化，保留恢复记录");
      }
    };
    if (candidate !== undefined) {
      const catalog = parseResponsesModelCatalog(candidate);
      if (selection !== undefined) {
        const model = catalog.definitions.find(entry => entry.id === selection.model);
        if (selection.model_catalog_json !== path || !model || selection.model_reasoning_effort !== (model.defaultReasoningEffort ?? "none")) {
          throw new Error("所选目录与当前配置不一致，请先恢复对应配置");
        }
      }
      if (guarded) assertRecoveryMaterials(current);
      writePrivateFileAtomicSync(path, candidate);
      try {
        await withResponsesModelCatalogWrite({path}, async () => {
          if (config.model_provider === id) {
            const primary = loadConfiguredCustomPrimaryModelProvider(environment);
            if (primary?.id !== id) throw new Error("固定提供商已变化，请重新核对恢复配置");
            loadConfiguredCustomPrimaryCredential(environment, primary);
          }
          if (registered) loadConfiguredCustomSwitchingModelProviders(environment, id);
        });
      } catch (error) {
        if (guarded) assertRecoveryMaterials(candidate);
        if (current !== undefined) writePrivateFileAtomicSync(path, current);
        else unlinkSync(path);
        throw error;
      }
    }
    if (candidate === undefined && existsSync(path)) {
      if (guarded) assertRecoveryMaterials(current);
      unlinkSync(path);
    }
    if (guarded) assertRecoveryMaterials(candidate);
    unlinkSync(`${path}.pending`);
    return { providerId: id, action };
  });
}

function readOptionalConfig(path, environment) {
  let content;
  try {
    content = createProviderFileReader(environment)(path);
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
  try {
    return parse(content);
  } catch {
    // TOML 解析错误可能包含凭据原文，不向调用方传递。
    throw new Error("自定义提供商恢复配置无法安全解析");
  }
}
