import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";

import { responsesProviderCatalogPath } from "./model-provider-responses-catalog.mjs";
import { readPrivateFileSync, writePrivateFileAtomicSync } from "./private-file.mjs";

const maximumMetadataBytes = 16 * 1024;
const metadataFileName = "provider.json";
const supportedKeys = ["schemaVersion", "upstreamWireApi"];

/** 自定义第三方 Provider 的上游接口；客户端侧恒为 Responses，这里只描述网关后面接什么。 */
export const customProviderUpstreamWireApis = Object.freeze(["responses", "chat_completions"]);
export const defaultCustomProviderUpstreamWireApi = "responses";

/**
 * 每个自定义 Provider 的网关侧元数据文件，与模型目录同目录；
 * Codex 只读取模型目录，不读取该文件。
 */
export function customProviderUpstreamMetadataPath(environment = process.env, provider) {
  return join(dirname(responsesProviderCatalogPath(environment, provider)), metadataFileName);
}

/** 缺失按默认 responses；版本、字段或枚举不合法时失败关闭，不回退。 */
export function readCustomProviderUpstreamWireApi(environment = process.env, provider) {
  const path = customProviderUpstreamMetadataPath(environment, provider);
  if (!existsSync(path)) return defaultCustomProviderUpstreamWireApi;
  let parsed;
  try {
    parsed = JSON.parse(readPrivateFileSync(path, maximumMetadataBytes));
  } catch {
    throw new Error("自定义 Provider 元数据无法安全读取");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("自定义 Provider 元数据无效");
  }
  if (parsed.schemaVersion !== 1 || Object.keys(parsed).some(key => !supportedKeys.includes(key))) {
    throw new Error("自定义 Provider 元数据版本或字段不受支持");
  }
  if (!customProviderUpstreamWireApis.includes(parsed.upstreamWireApi)) {
    throw new Error("自定义 Provider 上游接口不受支持");
  }
  return parsed.upstreamWireApi;
}

export function writeCustomProviderUpstreamWireApi(environment = process.env, provider, upstreamWireApi) {
  if (!customProviderUpstreamWireApis.includes(upstreamWireApi)) {
    throw new Error("自定义 Provider 上游接口不受支持");
  }
  const path = customProviderUpstreamMetadataPath(environment, provider);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writePrivateFileAtomicSync(path, `${JSON.stringify({ schemaVersion: 1, upstreamWireApi }, null, 2)}\n`);
}

export function removeCustomProviderUpstreamMetadata(environment = process.env, provider) {
  const path = customProviderUpstreamMetadataPath(environment, provider);
  try {
    unlinkSync(path);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}
