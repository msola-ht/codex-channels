import { parentPort, workerData } from "node:worker_threads";
import { readPrivateFileSync, assertPrivateConfigAccessSync } from "./private-file.mjs";
import { parseGatewayConfig, validateGatewayConfigDocument, validateDebugConfigDocument } from "./gateway-config.mjs";
import { modelRelayConfigSchema, modelRelayConfigDigest } from "./model-relay-config.mjs";
import { loadConfiguredRelayProviderMaterial, listRelayProviderIds } from "./model-provider-runtime.mjs";
import { readCodexProxySnapshot } from "./codex-proxy-env.mjs";

if (!parentPort) throw new Error("Internal Relay worker requires a parent");
parentPort.on("message", () => {
  try {
    const { configPath, environment } = workerData;
    assertPrivateConfigAccessSync(configPath);
    const content = readPrivateFileSync(configPath, 1024 * 1024);
    const document = validateGatewayConfigDocument(parseGatewayConfig(content));
    const config = document.model_relay ?? modelRelayConfigSchema.parse({});
    if (workerData.purpose === "metrics") {
      let providers = [];
      try { providers = listRelayProviderIds(environment); } catch { /* Reject unknown accounts. */ }
      if (readPrivateFileSync(configPath, 1024 * 1024) !== content) throw new Error("Configuration changed during read");
      parentPort.postMessage({ ok: true, providers, callers: config.callers.map(({ caller_id, key_id, provider, credential_generation }) =>
        ({ caller_id, key_id, provider, credential_generation })) });
      return;
    }
    const materials = []; const unavailable = [];
    if (config.enabled) for (const account of config.accounts) {
      try { materials.push(loadConfiguredRelayProviderMaterial(account.provider, environment)); }
      catch { unavailable.push(account.provider); }
    }
    const proxy = readCodexProxySnapshot(environment);
    if (readPrivateFileSync(configPath, 1024 * 1024) !== content) throw new Error("Configuration changed during read");
    parentPort.postMessage({ ok: true, config, debug: validateDebugConfigDocument(document.debug ?? {}), digest: modelRelayConfigDigest(config), materials, unavailable,
      proxy: proxy.settings, proxyPath: proxy.path });
  } catch { parentPort.postMessage({ ok: false }); }
});
