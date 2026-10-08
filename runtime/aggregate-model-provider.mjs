import { join } from "node:path";
import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import { parse } from "smol-toml";
import { codexHomePath } from "./codex-home.mjs";
import { loadManagedProviderProfiles, managedProviderDirectory, managedProviderMarkerPath, readCodexConfigFile } from "./model-provider-managed-runtime.mjs";
import { loadManagedModelProviderDefinitions } from "./model-provider-definitions.mjs";
import { readPrivateFileSync, writePrivateFileAtomicSync } from "./private-file.mjs";
import { deepseekAccountsFilePath } from "./deepseek-accounts.mjs";
import { clinePassAccountsFilePath } from "./cline-pass-accounts.mjs";
import { ccgAccountsFilePath } from "./ccg-accounts.mjs";
import { opencodeGoAccountsFilePath } from "./opencode-go-accounts.mjs";
import { loadConfiguredCustomSwitchingModelProviders, loadCustomSwitchingProviderIds,
  customPrimaryProviderProfilePath, customSwitchingProviderRegistryPath } from "./model-provider-custom-runtime.mjs";
import { customOfficialModelCatalogPath } from "./model-provider-official-catalog.mjs";
import { isResponsesProvider, responsesProviderCatalogPath, responsesContextSyncPath,
  assertResponsesContextSyncComplete } from "./model-provider-responses-catalog.mjs";

export const aggregateProviderId = "codexc-aggregate";
export const aggregateTokenEnvironmentKey = "CODEX_CONNECT_AGGREGATE_TOKEN";

// This is a derived, on-demand instance, not another account or persisted selection.
export function aggregateProviderMembers(primaryProvider, providers) {
  // Callers supply configured switching instances, whose loaders require their
  // own API credentials. The primary instance (including OAuth) is never added.
  const members = [...new Set(providers.map(entry => entry.provider))]
    .filter(id => id !== primaryProvider && id !== "openai" && id !== aggregateProviderId);
  return members.length >= 2 ? members : [];
}

/** Source paths only: safe for watchers, with no credential material returned. */
export function aggregateProviderMaterialFiles(environment, expectedMembers) {
  const paths = new Map([
    [deepseekAccountsFilePath(environment), 1_048_576],
    [clinePassAccountsFilePath(environment), 1_048_576],
    [ccgAccountsFilePath(environment), 1_048_576],
    [opencodeGoAccountsFilePath(environment), 1_048_576],
    [customSwitchingProviderRegistryPath(environment), 262_144],
    [responsesContextSyncPath(environment), 1_048_576],
  ]);
  const definitions = loadManagedModelProviderDefinitions(environment);
  const customIds = loadCustomSwitchingProviderIds(environment);
  for (const id of expectedMembers) {
    const definition = definitions.find(entry => entry.id === id);
    if (definition) {
      paths.set(managedProviderMarkerPath(environment, definition), 1_048_576);
      paths.set(join(codexHomePath(environment), definition.profileFileName), 1_048_576);
      paths.set(join(managedProviderDirectory(environment, definition), definition.catalogFileName), 2_097_152);
    } else if (customIds.includes(id)) {
      paths.set(customPrimaryProviderProfilePath(environment, id), 1_048_576);
      const catalogPath = isResponsesProvider(id)
        ? responsesProviderCatalogPath(environment, id) : customOfficialModelCatalogPath(environment);
      paths.set(catalogPath, isResponsesProvider(id) ? 2_097_152 : 8_388_608);
      if (isResponsesProvider(id)) paths.set(`${catalogPath}.pending`, 1_048_576);
    } else {
      throw new Error("聚合账户拓扑已变化，需要显式重启 App Server 服务");
    }
  }
  return [...paths].map(([path, maximumBytes]) => ({ path, maximumBytes }));
}

/** Shared by settings snapshots and the request-time worker; returns no source text. */
export function readAggregateMaterialFileDigest(file) {
  try {
    // Check absence before Windows ACL verification, which intentionally reports
    // unsafe/missing private paths with a structured ACL error rather than ENOENT.
    lstatSync(file.path);
    const content = readPrivateFileSync(file.path, file.maximumBytes);
    return createHash("sha256").update(content).digest("hex");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    // eslint-disable-next-line preserve-caught-error
    throw new Error("聚合源文件无法安全读取");
  }
}

function materialFiles(environment, expectedMembers) {
  return aggregateProviderMaterialFiles(environment, expectedMembers)
    .map(file => ({ ...file, digest: readAggregateMaterialFileDigest(file) }));
}

function materialFingerprint(expectedMembers, files) {
  return createHash("sha256").update(JSON.stringify([expectedMembers, files])).digest("hex");
}

export function readAggregateProviderSettingsFingerprint(environment, expectedMembers) {
  return materialFingerprint(expectedMembers, materialFiles(environment, expectedMembers));
}

export function loadAggregateModelMaterial(environment, expectedMembers) {
  assertResponsesContextSyncComplete(environment);
  const files = materialFiles(environment, expectedMembers);
  const fingerprint = materialFingerprint(expectedMembers, files);
  // Main configuration is an instance validation input, not third-party model
  // material. Read it when loading/applying material, never in its change digest.
  let config;
  try { config = parse(readCodexConfigFile(join(codexHomePath(environment), "config.toml"))); }
  catch (error) {
    // Do not expose a TOML parser error containing credential-bearing source text.
    // eslint-disable-next-line preserve-caught-error
    if (error?.code !== "ENOENT") throw new Error("聚合模式无法安全读取 Codex 配置");
    config = {};
  }
  if (config.model_context_window !== undefined || config.model_auto_compact_token_limit !== undefined) {
    throw new Error("聚合模式需要使用各模型自己的窗口；请先移除 Codex 全局 model_context_window 与 model_auto_compact_token_limit 覆盖");
  }
  // Deduplicate shared catalogues; request-time checks use the worker, never the
  // service loop. Custom profiles use their existing independent-key validator.
  const configuredProfiles = [
    ...loadManagedProviderProfiles(environment, { requireLaunchConfig: true }),
    ...loadConfiguredCustomSwitchingModelProviders(environment).map(profile => ({
      ...profile, catalogPath: profile.catalogSource.kind === "custom"
        ? profile.catalogSource.path : customOfficialModelCatalogPath(environment),
    })),
  ];
  if (JSON.stringify(aggregateProviderMembers("openai", configuredProfiles)) !== JSON.stringify(expectedMembers)) {
    throw new Error("聚合账户拓扑已变化，需要显式重启 App Server 服务");
  }
  const profiles = configuredProfiles.filter(entry => expectedMembers.includes(entry.provider));
  if (profiles.length !== expectedMembers.length || profiles.length < 2) {
    throw new Error("聚合账户已变化，需要显式重启 App Server 服务");
  }
  const models = [];
  const routes = new Map();
  const catalogs = new Map();
  for (const profile of profiles) {
    if (typeof profile.apiKey !== "string" || !profile.apiKey.length || profile.apiKey.length > 4096 || /\p{Cc}/u.test(profile.apiKey)) {
      throw new Error("聚合 Provider 缺少有效的独立 API Key");
    }
    let catalog = catalogs.get(profile.catalogPath);
    if (!catalog) {
      try { catalog = JSON.parse(readPrivateFileSync(profile.catalogPath,
        files.find(file => file.path === profile.catalogPath)?.maximumBytes ?? 2_097_152)); }
      catch { throw new Error("聚合模型目录无法安全读取"); }
      catalogs.set(profile.catalogPath, catalog);
    }
    if (!Array.isArray(catalog?.models) || !catalog.models.length
      || !catalog.models.some(model => model?.slug === profile.model)) {
      throw new Error("聚合 Provider 默认模型必须存在于非空模型目录");
    }
    for (const model of catalog.models) {
      if (!model || typeof model.slug !== "string" || !model.slug.length || model.slug.length > 200 || /\p{Cc}/u.test(model.slug)) {
        throw new Error("聚合模型目录包含无效模型 ID");
      }
      const slug = `${profile.provider}/${model.slug}`;
      if (routes.has(slug)) throw new Error("聚合模型 ID 重复");
      models.push({ ...model, slug,
        display_name: `${profile.provider} · ${model.display_name ?? model.slug}`,
        // Provider-local upgrade targets must never escape the aggregate whitelist.
        upgrade: null,
      });
      routes.set(slug, { provider: profile.provider, model: model.slug, apiKey: profile.apiKey });
    }
  }
  if (readAggregateProviderSettingsFingerprint(environment, expectedMembers) !== fingerprint) {
    throw new Error("聚合账户或模型目录在读取期间发生变化");
  }
  assertResponsesContextSyncComplete(environment);
  const first = profiles[0];
  return { catalog: { models }, routes, profiles, files, fingerprint,
    defaultModel: `${first.provider}/${first.model}`, reasoningEffort: first.reasoningEffort };
}

export function aggregateLaunchArguments(material, dataDir, baseUrl) {
  const catalogPath = join(dataDir, "runtime", "aggregate-models.json");
  const content = `${JSON.stringify(material.catalog, null, 2)}\n`;
  if (Buffer.byteLength(content) > 8_388_608) throw new Error("聚合模型目录超过 8 MiB");
  writePrivateFileAtomicSync(catalogPath, content);
  const settings = {
    model: material.defaultModel,
    model_provider: aggregateProviderId,
    model_catalog_json: catalogPath,
    model_reasoning_effort: material.reasoningEffort,
    service_tier: "default",
    web_search: "disabled",
    approvals_reviewer: "user",
    [`model_providers.${aggregateProviderId}.name`]: "聚合提供商",
    [`model_providers.${aggregateProviderId}.base_url`]: baseUrl,
    [`model_providers.${aggregateProviderId}.env_key`]: aggregateTokenEnvironmentKey,
    [`model_providers.${aggregateProviderId}.wire_api`]: "responses",
    [`model_providers.${aggregateProviderId}.requires_openai_auth`]: false,
    [`model_providers.${aggregateProviderId}.supports_websockets`]: false,
    [`model_providers.${aggregateProviderId}.request_max_retries`]: 0,
    [`model_providers.${aggregateProviderId}.stream_max_retries`]: 0,
  };
  return Object.entries(settings).filter(([, value]) => value !== undefined)
    .flatMap(([key, value]) => ["-c", `${key}=${JSON.stringify(value)}`]);
}
