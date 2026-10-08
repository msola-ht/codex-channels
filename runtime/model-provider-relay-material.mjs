import { readClineRelayCatalog, clineRelayCatalogPath, clineRelayInputModalities, clineRelayReasoningEfforts } from "./cline-relay-catalog.mjs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { codexHomePath } from "./codex-home.mjs";
import { loadManagedModelProviderDefinitions } from "./model-provider-definitions.mjs";
import { loadConfiguredManagedProviderMaterial, loadConfiguredManagedProviderCredentials } from "./model-provider-managed-runtime.mjs";
import { createProviderFileReader } from "./provider-file-access.mjs";
import { loadCustomSwitchingProviderIds, loadConfiguredCustomSwitchingModelProviders,
  customPrimaryProviderProfilePath, customSwitchingProviderRegistryPath,
  loadConfiguredCustomPrimaryModelProvider, loadConfiguredCustomPrimaryRelayProfile } from "./model-provider-custom-runtime.mjs";
import { customOfficialModelCatalogPath } from "./model-provider-official-catalog.mjs";
import { isResponsesProvider, readResponsesModelCatalog, responsesProviderCatalogPath,
  assertResponsesContextSyncComplete, responsesContextSyncPath } from "./model-provider-responses-catalog.mjs";
import { readPrivateFileSync } from "./private-file.mjs";

/** Registration is distinct from credential availability, including metrics settlement. */
export function listRelayProviderIds(environment = process.env) {
  const ids = loadManagedModelProviderDefinitions(environment).map(value => value.id);
  ids.push(...loadCustomSwitchingProviderIds(environment));
  const primary = loadConfiguredCustomPrimaryModelProvider(environment);
  if (primary) ids.push(primary.id);
  return [...new Set(ids)];
}

/** Reuses Provider-owned parsing; never uses App Server instances or OAuth credentials. */
export function loadConfiguredRelayProviderMaterial(provider, environment = process.env) {
  if (/^clp-[a-z0-9_-]{1,32}$/u.test(provider)) {
    const credentials = loadConfiguredManagedProviderCredentials(provider, environment);
    const catalog = readClineRelayCatalog(environment);
    if (catalog.status !== "ready") throw new Error("Relay Cline model catalog is unavailable; download it in WebUI");
    const models = catalog.catalog.models.map(model => model.id);
    return { ...credentials, models, modelInputs: Object.fromEntries(catalog.catalog.models.map(model => [model.id, clineRelayInputModalities(model)])), protocols: ["chat"],
      modelCapabilities: catalog.catalog.models.map(model => ({ id: model.id, reasoning_efforts: clineRelayReasoningEfforts(model) })),
      paths: [...credentials.paths, clineRelayCatalogPath(environment)],
      revision: createHash("sha256").update(credentials.revision).update(JSON.stringify(catalog.catalog.models)).digest("hex") };
  }
  return loadBaseRelayProviderMaterial(provider, environment);
}

function loadBaseRelayProviderMaterial(provider, environment) {
  if (loadManagedModelProviderDefinitions(environment).some(value => value.id === provider)) {
    return loadConfiguredManagedProviderMaterial(provider, environment);
  }
  assertResponsesContextSyncComplete(environment);
  const switching = loadCustomSwitchingProviderIds(environment).includes(provider);
  if (!switching && loadConfiguredCustomPrimaryModelProvider(environment)?.id !== provider) {
    throw new Error("Relay requires a registered Provider with independently managed API credentials");
  }
  const catalogPath = isResponsesProvider(provider) ? responsesProviderCatalogPath(environment, provider) : customOfficialModelCatalogPath(environment);
  const configPath = join(codexHomePath(environment), "config.toml");
  const paths = [...(switching ? [customSwitchingProviderRegistryPath(environment), customPrimaryProviderProfilePath(environment, provider)] : []),
    configPath, catalogPath];
  const fingerprint = () => {
    const hash = createHash("sha256");
    const read = createProviderFileReader(environment);
    for (const path of paths) hash.update(JSON.stringify([path, read(path, 8 * 1024 * 1024)]));
    return hash.digest("hex");
  };
  const revision = fingerprint();
  const profile = switching ? loadConfiguredCustomSwitchingModelProviders(environment, provider)[0]
    : loadConfiguredCustomPrimaryRelayProfile(provider, environment);
  if (!profile) throw new Error("Relay Provider was removed");
  const catalog = isResponsesProvider(provider) ? readResponsesModelCatalog(environment, provider)
    : JSON.parse(readPrivateFileSync(catalogPath, 8 * 1024 * 1024));
  const models = catalog.models?.map(value => value.slug);
  if (!Array.isArray(models) || !models.length || models.some(value => typeof value !== "string" || !value.length || value.length > 200 || /\p{Cc}/u.test(value))) {
    throw new Error("Relay Provider model catalog is invalid");
  }
  if (fingerprint() !== revision) throw new Error("Relay Provider material changed during read");
  assertResponsesContextSyncComplete(environment);
  const modelInputs = Object.fromEntries(catalog.models.map(value => [value.slug, Array.isArray(value.input_modalities) ? value.input_modalities : []]));
  return { provider, baseUrl: profile.baseUrl, apiKey: profile.apiKey, models, modelInputs, protocols: ["responses"],
    paths: [...paths, responsesContextSyncPath(environment)], revision };
}
