import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";

import { parse } from "smol-toml";

const maximumConfigBytes = 1_048_576;
const maximumCatalogBytes = 2_097_152;
const managedMarkerName = "codex-connect-deepseek.config.toml";
const deepseekApiKeyEnvironmentKey = "CODEX_CONNECT_DEEPSEEK_API_KEY";

const providers = Object.freeze({
  deepseek: Object.freeze({
    id: "deepseek",
    profileName: "deepseek.config.toml",
    baseUrl: "https://api.deepseek.com/",
    wireApi: "responses",
  }),
});

export function loadManagedModelProvider(environment = process.env) {
  const profile = loadManagedProviderProfile(environment);
  return profile === undefined ? undefined : { provider: profile.provider };
}

export function loadManagedProviderAppServer(environment = process.env) {
  const profile = loadManagedProviderProfile(environment, { requireLaunchConfig: true });
  if (profile === undefined) return undefined;
  return {
    provider: profile.provider,
    arguments: [
      "-c", `model=${JSON.stringify(profile.model)}`,
      "-c", `model_provider=${JSON.stringify(profile.provider)}`,
      "-c", `model_reasoning_effort=${JSON.stringify(profile.reasoningEffort)}`,
      "-c", 'service_tier="default"',
      "-c", `model_catalog_json=${JSON.stringify(profile.catalogPath)}`,
      "-c", `model_providers.${profile.provider}.name=${JSON.stringify(profile.name)}`,
      "-c", `model_providers.${profile.provider}.base_url=${JSON.stringify(profile.baseUrl)}`,
      "-c", `model_providers.${profile.provider}.wire_api=${JSON.stringify(profile.wireApi)}`,
      "-c", `model_providers.${profile.provider}.env_key=${JSON.stringify(deepseekApiKeyEnvironmentKey)}`,
      "-c", `model_providers.${profile.provider}.requires_openai_auth=false`,
    ],
    childEnvironment: {
      [deepseekApiKeyEnvironmentKey]: profile.apiKey,
    },
  };
}

export function validateConfiguredModelProvider(environment = process.env) {
  const configured = loadConfiguredProviderProfile(environment);
  return configured === undefined
    ? undefined
    : { provider: configured.provider, mode: configured.mode };
}

export function loadPrimaryModelProvider(environment = process.env) {
  const marker = readManagedMarker(codexHomePath(environment));
  return marker?.mode === "exclusive" ? marker.provider : "openai";
}

export function providerAppServerSocketPath(primarySocketPath, provider) {
  const extension = extname(primarySocketPath);
  const stem = basename(primarySocketPath, extension);
  return resolve(dirname(primarySocketPath), `${stem}-${provider}${extension}`);
}

export function loadDeepseekAccountCredential(environment = process.env) {
  const managed = loadManagedProviderProfile(environment);
  if (managed !== undefined) return managed.apiKey;
  const configPath = join(codexHomePath(environment), "config.toml");
  return readProviderProfile(configPath, providers.deepseek, { requireSelection: false }).apiKey;
}

function loadManagedProviderProfile(environment, { requireLaunchConfig = false } = {}) {
  const codexHome = codexHomePath(environment);
  const marker = readManagedMarker(codexHome);
  if (!marker || marker.mode === "exclusive") return undefined;
  const descriptor = providers.deepseek;
  const profile = readProviderProfile(join(codexHome, descriptor.profileName), descriptor, {
    ...(requireLaunchConfig
      ? { expectedCatalogPath: join(codexHome, "deepseek.models.json") }
      : {}),
  });
  if (requireLaunchConfig) validateModelCatalog(profile.catalogPath);
  return profile;
}

function loadConfiguredProviderProfile(environment) {
  const codexHome = codexHomePath(environment);
  const marker = readManagedMarker(codexHome);
  if (!marker) return undefined;
  const descriptor = providers.deepseek;
  const profilePath = marker.mode === "exclusive"
    ? join(codexHome, "config.toml")
    : join(codexHome, descriptor.profileName);
  const profile = readProviderProfile(profilePath, descriptor, {
    expectedCatalogPath: join(codexHome, "deepseek.models.json"),
  });
  validateModelCatalog(profile.catalogPath);
  return { ...profile, mode: marker.mode };
}

function readProviderProfile(
  path,
  descriptor,
  { requireSelection = true, expectedCatalogPath } = {},
) {
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
  if (
    expectedCatalogPath !== undefined
    && (
      document.model_reasoning_effort !== "high"
      || document.model_catalog_json !== expectedCatalogPath
    )
  ) {
    throw new Error("Codex DeepSeek Profile 模型目录或推理强度无效");
  }
  const provider = record(record(document.model_providers)[descriptor.id]);
  if (
    provider.name !== descriptor.id
    || provider.base_url !== descriptor.baseUrl
    || provider.wire_api !== descriptor.wireApi
    || provider.requires_openai_auth !== false
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
    model: document.model,
    reasoningEffort: document.model_reasoning_effort,
    catalogPath: document.model_catalog_json,
    name: descriptor.id,
    baseUrl: descriptor.baseUrl,
    wireApi: descriptor.wireApi,
    apiKey,
  };
}

function readPrivateFile(path, maximumBytes = maximumConfigBytes) {
  const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
  const descriptor = openSync(path, constants.O_RDONLY | noFollow);
  try {
    const metadata = fstatSync(descriptor);
    const currentUid = process.getuid?.();
    if (
      !metadata.isFile()
      || metadata.size > maximumBytes
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

function validateModelCatalog(path) {
  let catalog;
  try {
    catalog = JSON.parse(readPrivateFile(path, maximumCatalogBytes));
  } catch {
    throw new Error("Codex DeepSeek 模型目录无法安全读取");
  }
  if (
    !Array.isArray(catalog?.models)
    || !catalog.models.some((model) => record(model).slug === "deepseek-v4-flash")
  ) {
    throw new Error("Codex DeepSeek 模型目录无效");
  }
}

function readManagedMarker(codexHome) {
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
  if (
    marker.version !== 1
    || marker.provider !== "deepseek"
    || ![undefined, "switching", "exclusive"].includes(marker.mode)
  ) {
    throw new Error("Codex Connect 模型 Provider 标记无效");
  }
  return {
    provider: marker.provider,
    mode: marker.mode ?? "switching",
  };
}

function codexHomePath(environment) {
  return resolve(environment.CODEX_HOME?.trim() || join(homedir(), ".codex"));
}

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
}
