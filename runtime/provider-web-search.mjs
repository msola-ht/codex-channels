import { createHash } from "node:crypto";
import { join } from "node:path";
import { parse } from "smol-toml";
import { codexHomePath } from "./codex-home.mjs";
import { createProviderFileReader } from "./provider-file-access.mjs";
import { managedProviderAccountFamilies } from "./model-provider-definitions.mjs";
import {
  customPrimaryProviderProfilePath,
  loadCustomSwitchingProviderIds,
  validateCustomPrimaryModelProviderId,
} from "./model-provider-custom-runtime.mjs";
import { readPrivateFileSync } from "./private-file.mjs";

const modes = new Set(["disabled", "cached", "indexed", "live"]);

export class ProviderWebSearchSettingsError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = "ProviderWebSearchSettingsError";
    this.code = code;
  }
}

/** Validate exact key syntax, excluding the internal aggregate ID; management checks membership. */
export function isProviderWebSearchId(provider) {
  return typeof provider === "string" && /^[A-Za-z0-9_-]{1,64}$/u.test(provider)
    && provider !== "codexc-aggregate";
}

/** Resolve the file Codex actually consumes; fixed providers share the native global field. */
export function resolveProviderWebSearchConfig(provider, environment = process.env) {
  if (!isProviderWebSearchId(provider)) throw invalidDocument("Provider 搜索设置的 Provider ID 无效");
  const global = { path: join(codexHomePath(environment), "config.toml"), source: "global" };
  if (provider === "openai") return global;
  try {
    const family = managedProviderAccountFamilies.find(candidate => candidate.matches(provider));
    if (family) {
      const account = family.loadAccounts(environment).find(candidate => family.providerId(candidate.id) === provider);
      if (!account) throw invalidDocument("Provider 搜索设置的账户未配置");
      const marker = parse(readPrivateFileSync(family.markerPath(environment, account.id)));
      if (marker.version !== 1 || marker.provider !== provider || ![undefined, "switching", "exclusive"].includes(marker.mode)) {
        throw invalidDocument("Provider 搜索设置的账户标记无效");
      }
      return marker.mode === "exclusive" ? global
        : { path: join(codexHomePath(environment), family.accountDefinition(account).profileFileName), source: "provider" };
    }
    if (validateCustomPrimaryModelProviderId(provider, environment) !== null) throw invalidDocument("Provider 搜索设置的 Provider ID 不受支持");
    if (loadCustomSwitchingProviderIds(environment).includes(provider)) {
      return { path: customPrimaryProviderProfilePath(environment, provider), source: "provider" };
    }
    const config = readConfig(global.path, environment);
    if (!record(config.model_providers) || !record(config.model_providers[provider])) throw invalidDocument("Provider 搜索设置的 Provider 未配置");
    return global;
  } catch (error) {
    if (error instanceof ProviderWebSearchSettingsError) throw error;
    // Marker, registry and TOML errors may contain credentials or raw input.
    throw new ProviderWebSearchSettingsError("unreadable", "Provider 搜索设置的配置来源无法安全读取");
  }
}

export function readProviderWebSearchConfig(provider, environment = process.env) {
  const target = resolveProviderWebSearchConfig(provider, environment);
  assertNoPending(target.path);
  const config = readConfig(target.path, environment, provider === "openai");
  if (target.source === "provider" && config.model_provider !== provider) throw invalidDocument("Provider 搜索设置的 Profile 与 Provider 不匹配");
  const mode = config.web_search ?? null;
  if (mode !== null && !modes.has(mode)) throw new ProviderWebSearchSettingsError("invalid-mode", "Provider 搜索设置包含不支持的模式");
  assertNoPending(target.path);
  const current = resolveProviderWebSearchConfig(provider, environment);
  if (current.path !== target.path || current.source !== target.source) throw invalidDocument("Provider 搜索设置的配置来源在读取期间发生变化");
  return { ...target, mode };
}

export function readProviderWebSearchOverride(provider, environment = process.env) {
  if (!isProviderWebSearchId(provider)) throw invalidDocument("Provider 搜索设置的 Provider ID 无效");
  // Official accounts use native global configuration; no provider override is applied.
  return provider === "openai" ? null : readProviderWebSearchConfig(provider, environment).mode;
}

/** Only this provider's actual search field participates in its instance identity. */
export function readProviderWebSearchFingerprint(provider, environment = process.env) {
  return createHash("sha256").update(JSON.stringify(["provider-web-search-v2", provider,
    readProviderWebSearchOverride(provider, environment)])).digest("hex");
}

function assertNoPending(path) {
  try { readPrivateFileSync(`${path}.search-pending`, 4096); }
  catch (error) {
    if (error?.code !== "ENOENT") throw new ProviderWebSearchSettingsError("unreadable", "Provider 搜索设置事务记录无法安全读取");
    return;
  }
  throw invalidDocument("Provider 搜索设置保存尚未完成；请保留事务记录及备份并核对文件，勿自动重试");
}

function readConfig(path, environment, optional = false) {
  let content;
  try { content = createProviderFileReader(environment)(path); }
  catch (error) {
    if (optional && error?.code === "ENOENT") return {};
    throw new ProviderWebSearchSettingsError("unreadable", "Provider 搜索配置无法安全读取");
  }
  try { return parse(content); }
  catch { throw invalidDocument("Provider 搜索配置无法安全解析"); }
}

function invalidDocument(message) {
  return new ProviderWebSearchSettingsError("invalid-document", message);
}

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
