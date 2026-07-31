import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { parse } from "smol-toml";

const maximumConfigBytes = 1_048_576;
const managedMarkerName = "codex-connect-deepseek.config.toml";

const providers = Object.freeze({
  deepseek: Object.freeze({
    id: "deepseek",
    profileName: "deepseek.config.toml",
    childEnvironmentKey: "CODEX_CONNECT_DEEPSEEK_API_KEY",
    baseUrl: "https://api.deepseek.com/",
    wireApi: "responses",
  }),
});

export function loadManagedModelProvider(environment = process.env) {
  const codexHome = codexHomePath(environment);
  const markerPath = join(codexHome, managedMarkerName);
  let marker;
  try {
    marker = record(parse(readPrivateFile(markerPath)));
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    // TOML 解析错误可能包含带 API Key 的原始配置行，不能作为 cause 暴露。
    // eslint-disable-next-line preserve-caught-error
    throw new Error("Codex Connect 模型 Provider 标记无法安全读取");
  }
  if (marker.version !== 1 || marker.provider !== "deepseek") {
    throw new Error("Codex Connect 模型 Provider 标记无效");
  }
  const descriptor = providers.deepseek;
  const profilePath = join(codexHome, descriptor.profileName);
  return readProviderProfile(profilePath, descriptor);
}

export function loadDeepseekAccountCredential(environment = process.env) {
  const managed = loadManagedModelProvider(environment);
  if (managed !== undefined) return managed.apiKey;
  const configPath = join(codexHomePath(environment), "config.toml");
  return readProviderProfile(configPath, providers.deepseek, { requireSelection: false }).apiKey;
}

function readProviderProfile(path, descriptor, { requireSelection = true } = {}) {
  let document;
  try {
    document = record(parse(readPrivateFile(path)));
  } catch (error) {
    if (error?.code === "ENOENT") throw error;
    // TOML 解析错误可能包含带 API Key 的原始配置行，不能作为 cause 暴露。
    // eslint-disable-next-line preserve-caught-error
    throw new Error("Codex 模型 Provider 配置无法安全读取");
  }
  if (
    requireSelection
    && (document.model !== "deepseek-v4-flash" || document.model_provider !== descriptor.id)
  ) {
    throw new Error("Codex DeepSeek Profile 未选择受支持模型");
  }
  const provider = record(record(document.model_providers)[descriptor.id]);
  if (
    provider.name !== descriptor.id
    || provider.base_url !== descriptor.baseUrl
    || provider.wire_api !== descriptor.wireApi
    || provider.requires_openai_auth === true
  ) {
    throw new Error("Codex DeepSeek Provider 配置无效");
  }
  const apiKey = provider.experimental_bearer_token;
  if (
    typeof apiKey !== "string"
    || !/^sk-[^\s"]+$/u.test(apiKey)
    || apiKey.length > 4_096
    || /[\r\n]/u.test(apiKey)
  ) {
    throw new Error("Codex DeepSeek API Key 缺失或无效");
  }
  return {
    provider: descriptor.id,
    name: descriptor.id,
    baseUrl: descriptor.baseUrl,
    wireApi: descriptor.wireApi,
    childEnvironmentKey: descriptor.childEnvironmentKey,
    apiKey,
  };
}

function readPrivateFile(path) {
  const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
  const descriptor = openSync(path, constants.O_RDONLY | noFollow);
  try {
    const metadata = fstatSync(descriptor);
    const currentUid = process.getuid?.();
    if (
      !metadata.isFile()
      || metadata.size > maximumConfigBytes
      || (metadata.mode & 0o077) !== 0
      || (currentUid !== undefined && metadata.uid !== currentUid)
    ) {
      throw new Error("Codex Provider 配置文件权限或类型无效");
    }
    return readFileSync(descriptor, "utf8");
  } finally {
    closeSync(descriptor);
  }
}

function codexHomePath(environment) {
  return resolve(environment.CODEX_HOME?.trim() || join(homedir(), ".codex"));
}

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
}
