import { parseRelayModelId } from "./model-relay-model-id.mjs";
import { parentPort, workerData } from "node:worker_threads";
import { readPrivateFileSync, assertPrivateConfigAccessSync } from "./private-file.mjs";
import { parseGatewayConfig, validateGatewayConfigDocument, validateDebugConfigDocument } from "./gateway-config.mjs";
import { modelRelayConfigSchema, modelRelayConfigDigest } from "./model-relay-config.mjs";
import { loadConfiguredRelayProviderMaterial, listRelayProviderIds } from "./model-provider-runtime.mjs";
import { readCodexProxySnapshot } from "./codex-proxy-env.mjs";
import { withWindowsAclDeadline } from "./windows-acl-bridge.mjs";

if (!parentPort) throw new Error("Internal Relay worker requires a parent");
parentPort.on("message", request => {
  try {
    withWindowsAclDeadline(request?.deadline, readMaterials);
  } catch {
    parentPort.postMessage({ ok: false });
  }
});

function readMaterials() {
  // An atomic save may overlap a read. Discard that snapshot and reread once;
  // malformed/private-file failures still fail closed immediately. Reader deadlines apply.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const { configPath, environment } = workerData;
      assertPrivateConfigAccessSync(configPath);
      const content = readPrivateFileSync(configPath, 1024 * 1024);
      const document = validateGatewayConfigDocument(parseGatewayConfig(content));
      const config = document.model_relay ?? modelRelayConfigSchema.parse({});
      if (workerData.purpose === "metrics") {
        let providers = [];
        try { providers = listRelayProviderIds(environment); } catch { /* Reject unknown accounts. */ }
        if (readPrivateFileSync(configPath, 1024 * 1024) !== content) continue;
        parentPort.postMessage({ ok: true, providers, callers: [...config.callers.flatMap(caller => [...new Set(caller.models.map(id => parseRelayModelId(id).provider))].map(provider => ({ ...caller, provider }))), ...(config.retired_callers ?? [])].map(({ caller_id, key_id, provider, credential_generation }) =>
          ({ caller_id, key_id, provider, credential_generation })) });
        return;
      }
      const materials = []; const unavailable = [];
      if (config.enabled) for (const provider of new Set(config.callers.flatMap(caller => caller.models.map(id => parseRelayModelId(id).provider)))) {
        try { materials.push(loadConfiguredRelayProviderMaterial(provider, environment)); }
        catch { unavailable.push(provider); }
      }
      const proxy = readCodexProxySnapshot(environment);
      if (readPrivateFileSync(configPath, 1024 * 1024) !== content) continue;
      parentPort.postMessage({ ok: true, config, debug: validateDebugConfigDocument(document.debug ?? {}), digest: modelRelayConfigDigest(config), materials, unavailable,
        proxy: proxy.settings, proxyPath: proxy.path });
      return;
    } catch { break; }
  }
  parentPort.postMessage({ ok: false });
}
