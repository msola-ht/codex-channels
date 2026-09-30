import { watch } from "node:fs";
import { dirname, join } from "node:path";
import { HttpsProxyAgent } from "https-proxy-agent";
import { createRefreshableHttpProxySelector } from "./network-proxy.mjs";
import { ModelRelayMaterialReader } from "./model-relay-material-reader.mjs";
import { ModelRelayControl } from "./model-relay-control.mjs";
import { modelRelayPaths } from "./model-relay-paths.mjs";
import { relayPolicyFromConfig } from "./model-relay-config.mjs";

/** Independent service owner. Never starts, stops or connects to App Server. */
export async function startModelRelayService(configPath, environment = process.env) {
  const { ModelRelayServer, RelayMetricsSender } = await import("../dist/model-relay/index.js");
  const { sendRelayMetrics, RelayTrafficDump } = await import("../dist/provider-proxy/index.js");
  const paths = modelRelayPaths(configPath);
  const reader = new ModelRelayMaterialReader(configPath, environment);
  const dump = new RelayTrafficDump({ directory: join(dirname(configPath), "traffic"),
    onError: error => console.error(error.message) });
  let snapshot;
  let relay;
  let selector;
  let listening;
  let refreshTask;
  let closed = false;
  let closeTask;
  let poll;
  const watchers = new Map();
  const agents = new Map();
  const sender = new RelayMetricsSender((envelope, signal) => sendRelayMetrics(paths.metrics, envelope, signal));
  const unavailable = async () => {
    relay?.admission.failClosed();
    snapshot = undefined;
    await relay?.stopListening().catch(() => {}); listening = undefined;
  };
  const updateWatchers = next => {
    const directories = new Set([configPath, next.proxyPath, ...next.materials.flatMap(material => material.paths)].map(path => dirname(path)));
    for (const [directory, watcher] of watchers) if (!directories.has(directory)) { watcher.close(); watchers.delete(directory); }
    for (const directory of directories) if (!watchers.has(directory)) {
      try {
        const watcher = watch(directory, () => { void refresh().catch(() => {}); });
        watcher.on("error", () => { watcher.close(); watchers.delete(directory); }); watchers.set(directory, watcher);
      } catch { /* A removed directory is detected by the next bounded poll. */ }
    }
  };
  const publish = async next => {
    if (closed) throw new Error("Relay closed");
    if (!selector || JSON.stringify(snapshot?.proxy) !== JSON.stringify(next.proxy)) {
      for (const account of snapshot?.materials ?? []) relay?.admission.invalidateProvider(account.provider);
      await selector?.close();
      for (const agent of agents.values()) agent.destroy(); agents.clear();
      selector = createRefreshableHttpProxySelector(next.proxy, environment);
    }
    if (closed) throw new Error("Relay closed");
    for (const old of snapshot?.materials ?? []) {
      if (next.materials.find(value => value.provider === old.provider)?.revision !== old.revision) relay?.admission.invalidateProvider(old.provider);
    }
    dump.setRetentionDays(next.debug.model_traffic_retention_days);
    if (next.debug.model_traffic_dump) void dump.prepare();
    const policyChanged = !snapshot || snapshot.digest !== next.digest;
    snapshot = next;
    relay ??= new ModelRelayServer({ capture: async (provider, signal, protocol) => {
      if (!snapshot?.debug.model_traffic_dump) return undefined;
      await dump.prepare(signal);
      signal.throwIfAborted();
      // Initialization may outlive a configuration refresh; use the latest global settings.
      if (closed || !snapshot?.debug.model_traffic_dump) return undefined;
      const debug = snapshot.debug;
      return dump.begin(provider, debug.model_traffic_input_items === 0 && debug.model_traffic_item_max_bytes === 0, protocol);
    }, policy: relayPolicyFromConfig(next.config), enqueueMetric: sample => sender.enqueue(sample),
      prepare: async (provider, signal) => {
        await refreshCurrent(); signal.throwIfAborted();
        const initial = snapshot?.materials.find(value => value.provider === provider);
        if (!initial) throw new Error("Relay provider unavailable");
        const currentSelector = selector;
        const networkRevision = currentSelector.revision;
        const target = new URL(initial.baseUrl);
        const proxyUrl = await currentSelector.select(target);
        signal.throwIfAborted();
        await refreshCurrent(); signal.throwIfAborted();
        const material = snapshot?.materials.find(value => value.provider === provider);
        if (!material || material.revision !== initial.revision || selector !== currentSelector || currentSelector.revision !== networkRevision) throw new Error("Relay material revision changed");
        let agent;
        if (proxyUrl) {
          if (!agents.has(proxyUrl)) {
            if (agents.size >= 8) throw new Error("Relay network route capacity exceeded");
            agents.set(proxyUrl, new HttpsProxyAgent(proxyUrl, { maxSockets: snapshot.config.max_concurrency, maxFreeSockets: 2 }));
          }
          agent = agents.get(proxyUrl);
        }
        // URL keeps IPv6 brackets; Node's HTTP hostname option requires the bare address.
        const host = target.hostname.startsWith("[") ? target.hostname.slice(1, -1) : target.hostname;
        return { models: material.models, protocols: material.protocols, target: { host, port: target.port ? Number(target.port) : target.protocol === "http:" ? 80 : 443,
          protocol: target.protocol === "http:" ? "http" : "https", basePath: target.pathname, authorization: `Bearer ${material.apiKey}`, ...(agent ? { agent } : {}) },
          recheck: () => {
            signal.throwIfAborted();
            if (closed || !snapshot?.config.enabled || selector !== currentSelector || currentSelector.revision !== networkRevision
              || snapshot.materials.find(value => value.provider === provider)?.revision !== material.revision) throw new Error("Relay material revoked");
          } };
      } });
    if (policyChanged) relay.admission.apply(relayPolicyFromConfig(next.config));
    for (const agent of agents.values()) agent.maxSockets = next.config.max_concurrency;
    for (const provider of next.unavailable) relay.admission.invalidateProvider(provider);
    for (const material of next.materials) relay.admission.restoreProvider(material.provider);
    const address = next.config.enabled ? `${next.config.host}:${next.config.port}` : undefined;
    if (listening !== address) {
      if (listening) await relay.stopListening();
      if (closed) throw new Error("Relay closed");
      relay.admission.apply(relayPolicyFromConfig(next.config));
      if (address) await relay.start(next.config.port, next.config.host);
      listening = address;
    }
    updateWatchers(next);
  };
  function refresh() {
    if (closed) return Promise.reject(new Error("Relay closed"));
    if (refreshTask) return refreshTask;
    refreshTask = reader.read().then(publish).catch(async error => { await unavailable(); throw error; }).finally(() => {
      refreshTask = undefined;
    });
    return refreshTask;
  }
  async function refreshCurrent() {
    await refreshTask?.catch(() => {});
    return refresh();
  }
  const control = new ModelRelayControl(paths.control, async (request, signal) => {
    if (request.operation === "apply") {
      await refreshCurrent(); signal.throwIfAborted();
      if (snapshot?.digest !== request.digest) throw new Error("Relay policy digest mismatch");
      return { result: "applied", digest: snapshot.digest };
    }
    return { result: "status", configurationValid: snapshot !== undefined, enabled: snapshot?.config.enabled === true, listening: Boolean(listening),
      active: relay?.diagnostics().active ?? 0, queue: relay?.diagnostics().queue ?? { pending: 0, waiting: 0, bytes: 0, oldestWaitMs: 0, timedOut: 0 },
      capture: { ...dump.diagnostics(), enabled: snapshot?.debug.model_traffic_dump === true },
      unavailableAccounts: snapshot?.unavailable.length ?? 0, metrics: sender.diagnostics() };
  });
  const close = () => {
    if (closeTask) return closeTask;
    closed = true; clearInterval(poll);
    for (const watcher of watchers.values()) watcher.close(); watchers.clear();
    closeTask = (async () => {
      await control.close(); await reader.close();
      await refreshTask?.catch(() => {});
      await relay?.close(); await dump.close(); await sender.close(); await selector?.close();
      for (const agent of agents.values()) agent.destroy(); agents.clear();
    })();
    return closeTask;
  };
  try {
    await control.start(); await refresh();
    poll = setInterval(() => {
      void selector?.refresh().catch(() => {});
      void refresh().catch(() => {});
    }, 1000);
    return { close, refresh: refreshCurrent, status: () => ({ enabled: snapshot?.config.enabled === true, listening: Boolean(listening) }) };
  } catch (error) { await close(); throw error; }
}
