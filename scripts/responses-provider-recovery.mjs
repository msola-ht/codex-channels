import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { parse } from "smol-toml";

import { codexHomePath } from "../runtime/codex-home.mjs";
import { readPrivateFileSync, writePrivateFileAtomicSync } from "../runtime/private-file.mjs";
import { responsesProviderCatalogPath, readResponsesModelCatalog, withResponsesModelCatalogWrite, finishResponsesModelCatalogWrite } from "../runtime/model-provider-responses-catalog.mjs";
import {
  customPrimaryProviderProfilePath,
  loadCustomSwitchingProviderIds,
  loadConfiguredCustomSwitchingModelProviders,
  loadConfiguredCustomPrimaryModelProvider,
  readPrimaryProviderBackup,
} from "../runtime/model-provider-runtime.mjs";
import { withModelProviderManagementTransaction } from "./model-provider-management-transaction.mjs";

export async function recoverResponsesProviderCatalog(id, action, environment = process.env) {
  if (action !== "keep" && action !== "rollback") throw new Error("恢复操作必须是 keep 或 rollback");
  return withModelProviderManagementTransaction(environment, async () => {
    const path = responsesProviderCatalogPath(environment, id);
    let pending;
    try { pending = JSON.parse(readPrivateFileSync(`${path}.pending`)); } catch {
      throw new Error("没有可安全读取的 Responses 目录恢复记录");
    }
    if (pending?.schemaVersion !== 1 || typeof pending.previous !== "boolean" || Object.keys(pending).length !== 2) throw new Error("Responses 目录恢复记录格式无效");
    const previous = pending.previous ? readPrivateFileSync(`${path}.backup`, 2 * 1024 * 1024) : undefined;
    const current = existsSync(path) ? readPrivateFileSync(path, 2 * 1024 * 1024) : undefined;
    const candidate = action === "rollback" ? previous : current;
    if (action === "keep" && candidate === undefined) throw new Error("新目录尚未写入，请选择 rollback");
    const home = codexHomePath(environment);
    const config = readOptionalConfig(join(home, "config.toml")) ?? {};
    const profile = readOptionalConfig(customPrimaryProviderProfilePath(environment, id));
    const registered = loadCustomSwitchingProviderIds(environment).includes(id);
    if (registered !== (profile !== undefined)) {
      throw new Error("Responses Provider 的 Profile 与注册表不一致，请先恢复对应配置");
    }
    const configured = Object.hasOwn(config.model_providers ?? {}, id);
    const backedUp = Object.hasOwn(readPrimaryProviderBackup(environment), id);
    const referenced = registered || configured || backedUp || config.model_provider === id || config.model_catalog_json === path;
    if (action === "keep" && !referenced) throw new Error("Responses Provider 没有连接配置或备份，请先恢复配置或选择 rollback");
    const selection = config.model_provider === id ? config : profile;
    if (candidate === undefined && referenced) throw new Error("配置仍引用此目录，不能回滚删除；请先恢复配置");
    if (candidate !== undefined) {
      writePrivateFileAtomicSync(path, candidate);
      try {
        await withResponsesModelCatalogWrite({path}, async () => {
          const catalog = readResponsesModelCatalog(environment, id);
          if (selection !== undefined) {
            const model = catalog.definitions.find(entry => entry.id === selection.model);
            if (selection.model_catalog_json !== path || !model || selection.model_reasoning_effort !== (model.defaultReasoningEffort ?? "none")) {
              throw new Error("所选目录与当前配置不一致，请先恢复对应配置");
            }
          }
          if (config.model_provider === id) loadConfiguredCustomPrimaryModelProvider(environment);
          if (registered) loadConfiguredCustomSwitchingModelProviders(environment, id);
        });
      } catch (error) {
        if (current !== undefined) writePrivateFileAtomicSync(path, current);
        else unlinkSync(path);
        throw error;
      }
    }
    finishResponsesModelCatalogWrite({path, previous: undefined}, candidate === undefined);
    return { providerId: id, action };
  });
}

function readOptionalConfig(path) {
  let content;
  try {
    content = readPrivateFileSync(path);
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
  try {
    return parse(content);
  } catch {
    // TOML 解析错误可能包含凭据原文，不向调用方传递。
    throw new Error("Responses Provider 恢复配置无法安全解析");
  }
}
