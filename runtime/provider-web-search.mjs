import { createHash } from "node:crypto";
import { join } from "node:path";
import { parse } from "smol-toml";
import { codexHomePath } from "./codex-home.mjs";
import { readPrivateFileSync } from "./private-file.mjs";
import { managedProviderAccountFamilies } from "./model-provider-definitions.mjs";

const modes = new Set(["disabled", "cached", "indexed", "live"]);

export class ProviderWebSearchSettingsError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = "ProviderWebSearchSettingsError";
    this.code = code;
  }
}

export function providerWebSearchSettingsPath(environment = process.env) {
  return join(codexHomePath(environment), "codexc-provider-search.toml");
}

/** Validate exact key syntax, excluding the internal aggregate ID; management checks membership. */
export function isProviderWebSearchId(provider) {
  return typeof provider === "string" && /^[A-Za-z0-9_-]{1,64}$/u.test(provider)
    && provider !== "codexc-aggregate";
}

export function decodeProviderWebSearchSettings(content) {
  if (content === undefined) return { version: 1, providers: {} };
  let document;
  try { document = parse(content); }
  catch {
    // TOML errors can contain raw input; retain only the safe classification.
    throw new ProviderWebSearchSettingsError("invalid-document", "Provider 搜索设置无法解析");
  }
  if (!record(document) || Object.keys(document).some(key => !["version", "providers"].includes(key))
    || document.version !== 1 || !record(document.providers)) {
    throw new ProviderWebSearchSettingsError("invalid-document", "Provider 搜索设置格式或版本不受支持");
  }
  for (const [provider, mode] of Object.entries(document.providers)) {
    if (!isProviderWebSearchId(provider)) throw new ProviderWebSearchSettingsError("invalid-document", "Provider 搜索设置包含不支持的 Provider ID");
    if (!modes.has(mode)) throw new ProviderWebSearchSettingsError("invalid-mode", "Provider 搜索设置包含不支持的模式");
  }
  return { version: 1, providers: { ...document.providers } };
}

export function readProviderWebSearchOverride(provider, environment = process.env) {
  if (!isProviderWebSearchId(provider)) throw new ProviderWebSearchSettingsError("invalid-document", "Provider 搜索设置的 Provider ID 无效");
  // Official accounts always use native global configuration, never this overlay.
  if (provider === "openai") return null;
  assertNoPending(environment);
  const mode = readReadyOverride(provider, environment);
  assertNoPending(environment);
  return mode;
}

function assertNoPending(environment) {
  try {
    readPrivateFileSync(`${providerWebSearchSettingsPath(environment)}.pending`, 4096);
  } catch (error) {
    if (error?.code !== "ENOENT") throw new ProviderWebSearchSettingsError("unreadable", "Provider 搜索设置事务记录无法安全读取");
    return;
  }
  throw new ProviderWebSearchSettingsError("invalid-document", "Provider 搜索设置保存尚未完成；请保留事务记录及备份并核对文件，勿自动重试");
}

function readReadyOverride(provider, environment) {
  let content;
  try { content = readPrivateFileSync(providerWebSearchSettingsPath(environment)); }
  catch (error) {
    if (error?.code !== "ENOENT") throw new ProviderWebSearchSettingsError("unreadable", "Provider 搜索设置无法安全读取");
  }
  const { providers } = decodeProviderWebSearchSettings(content);
  return Object.hasOwn(providers, provider) ? providers[provider] : readExistingManagedOverride(provider, environment);
}

/** Preserve existing managed switching preferences until an explicit save clears them. */
function readExistingManagedOverride(provider, environment) {
  const family = managedProviderAccountFamilies.find(candidate => candidate.matches(provider));
  if (!family) return null;
  let account, marker, profile;
  try {
    account = family.loadAccounts(environment).find(candidate => family.providerId(candidate.id) === provider);
    if (!account) return null;
    let content;
    try { content = readPrivateFileSync(family.markerPath(environment, account.id)); }
    catch (error) { if (error?.code === "ENOENT") return null; throw error; }
    marker = parse(content);
    if (marker.version !== 1 || marker.provider !== provider || ![undefined, "switching", "exclusive"].includes(marker.mode)) {
      throw new Error("invalid-marker");
    }
    if (marker.mode === "exclusive") return null;
    const definition = family.accountDefinition(account);
    profile = parse(readPrivateFileSync(join(codexHomePath(environment), definition.profileFileName)));
  } catch {
    // Profile and registry parse errors may include credentials; never retain raw input.
    throw new ProviderWebSearchSettingsError("unreadable", "受管 Provider 搜索偏好无法安全读取");
  }
  if (profile.web_search === undefined) return null;
  if (!modes.has(profile.web_search)) throw new ProviderWebSearchSettingsError("invalid-mode", "受管 Provider 搜索偏好包含不支持的模式");
  return profile.web_search;
}

/** Only this provider's effective override participates in its instance identity. */
export function readProviderWebSearchFingerprint(provider, environment = process.env) {
  return createHash("sha256").update(JSON.stringify(["provider-web-search-v1", provider,
    readProviderWebSearchOverride(provider, environment)])).digest("hex");
}

export function providerWebSearchArguments(provider, environment = process.env) {
  const mode = readProviderWebSearchOverride(provider, environment);
  return mode === null ? [] : ["-c", `web_search=${JSON.stringify(mode)}`];
}

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
