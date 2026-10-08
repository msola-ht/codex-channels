import { join } from "node:path";
import { createHash } from "node:crypto";
import { parse } from "smol-toml";
import { codexHomePath } from "./codex-home.mjs";
import { loadManagedProviderProfiles, managedProviderDirectory, managedProviderMarkerPath, readCodexConfigFile } from "./model-provider-managed-runtime.mjs";
import { loadManagedModelProviderDefinitions } from "./model-provider-definitions.mjs";
import { readPrivateFileSync, writePrivateFileAtomicSync } from "./private-file.mjs";
import { deepseekAccountsFilePath } from "./deepseek-accounts.mjs";
import { clinePassAccountsFilePath } from "./cline-pass-accounts.mjs";

export const aggregateProviderId = "codexc-aggregate";
export const aggregateTokenEnvironmentKey = "CODEX_CONNECT_AGGREGATE_TOKEN";

// This is a derived, on-demand instance, not another account or persisted selection.
export function aggregateProviderMembers(primaryProvider, providers) {
  if (primaryProvider !== "openai") return [];
  const members = providers.map(entry => entry.provider)
    .filter(id => id.startsWith("ds-") || id.startsWith("clp-"));
  return members.some(id => id.startsWith("ds-")) && members.some(id => id.startsWith("clp-"))
    ? members : [];
}

export function loadAggregateModelMaterial(environment, expectedMembers) {
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
  // Snapshot each authority file once, deduplicating shared catalogues. Request-time
  // ACL/content checks run in AggregateMaterialGuard's worker, never the service loop.
  const paths = new Map([
    [deepseekAccountsFilePath(environment), 1_048_576],
    [clinePassAccountsFilePath(environment), 1_048_576],
  ]);
  const definitions = loadManagedModelProviderDefinitions(environment);
  for (const id of expectedMembers) {
    const definition = definitions.find(entry => entry.id === id);
    if (!definition) throw new Error("聚合账户已变化，请重启 App Server 服务");
    paths.set(managedProviderMarkerPath(environment, definition), 1_048_576);
    paths.set(join(codexHomePath(environment), definition.profileFileName), 1_048_576);
    paths.set(join(managedProviderDirectory(environment, definition), definition.catalogFileName), 2_097_152);
  }
  const digest = (path, limit) => createHash("sha256").update(readPrivateFileSync(path, limit)).digest("hex");
  const files = [...paths].map(([path, maximumBytes]) => ({ path, maximumBytes, digest: digest(path, maximumBytes) }));
  const configuredProfiles = loadManagedProviderProfiles(environment, { requireLaunchConfig: true });
  if (JSON.stringify(aggregateProviderMembers("openai", configuredProfiles)) !== JSON.stringify(expectedMembers)) {
    throw new Error("聚合账户拓扑已变化，请重启 App Server 服务");
  }
  const profiles = configuredProfiles.filter(entry => expectedMembers.includes(entry.provider));
  if (profiles.length !== expectedMembers.length || profiles.length < 2) {
    throw new Error("聚合账户已变化，请重启 App Server 服务");
  }
  const models = [];
  const routes = new Map();
  for (const profile of profiles) {
    let catalog;
    try { catalog = JSON.parse(readPrivateFileSync(profile.catalogPath, 2_097_152)); }
    catch { throw new Error("聚合模型目录无法安全读取"); }
    for (const model of catalog.models) {
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
  for (const file of files) {
    if (digest(file.path, file.maximumBytes) !== file.digest) throw new Error("聚合账户或模型目录在读取期间发生变化");
  }
  const first = profiles[0];
  return { catalog: { models }, routes, profiles, files,
    defaultModel: `${first.provider}/${first.model}`, reasoningEffort: first.reasoningEffort };
}

export function aggregateLaunchArguments(material, dataDir, baseUrl) {
  const catalogPath = join(dataDir, "runtime", "aggregate-models.json");
  const content = `${JSON.stringify(material.catalog)}\n`;
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
    [`model_providers.${aggregateProviderId}.name`]: "DS + CLP",
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
