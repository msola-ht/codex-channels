import { createHash } from "node:crypto";
import { lstatSync, statSync } from "node:fs";
import { join } from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import { codexHomePath } from "./codex-home.mjs";
import { AggregateProviderTopologyChangedError, aggregateProviderId, aggregateProviderMaterialFiles, readAggregateProviderSettingsFingerprint } from "./aggregate-model-provider.mjs";
import { loadManagedModelProviderDefinitions, loadManagedModelProviderWatcherDefinitions } from "./model-provider-definitions.mjs";
import { managedProviderDirectory, managedProviderMarkerPath, readManagedMarker, validateConfiguredModelProviders } from "./model-provider-runtime.mjs";
import { readCodexConfigFile } from "./provider-file-access.mjs";
import { readPrivateFileSync } from "./private-file.mjs";
import { readProviderWebSearchFingerprint } from "./provider-web-search.mjs";
import { withWindowsAclDeadline, closeWindowsAclBridge, waitForWindowsAclBridgeExit } from "./windows-acl-bridge.mjs";

if (!parentPort) throw new Error("Provider settings worker requires a parent");
const { environment, aggregateMembers } = workerData;
const maximumSnapshotBytes = 32 * 1024 * 1024;
const maximumSnapshotFiles = 512;
let stopping = false;

async function close() {
  if (stopping) return;
  stopping = true;
  try { await closeWindowsAclBridge({ timeoutMs: 1_000 }); }
  catch { await waitForWindowsAclBridgeExit(); }
  parentPort.close();
}

function fingerprints() {
  let aggregateRestartRequired = false;
  const files = new Map();
  const groups = new Map();
  const configuredProviders = new Set();
  const home = codexHomePath(environment);
  for (const definition of loadManagedModelProviderWatcherDefinitions(environment)) {
    const marker = readManagedMarker(environment, definition);
    if (marker) configuredProviders.add(definition.id);
    const paths = [join(managedProviderDirectory(environment, definition), definition.catalogFileName)];
    if ("profileFileName" in definition) paths.push(
      join(home, marker?.mode === "exclusive" ? "config.toml" : definition.profileFileName),
      managedProviderMarkerPath(environment, definition),
    );
    if ("profileFileName" in definition) paths.push(`${paths[1]}.search-pending`);
    groups.set(definition.id, [...new Set([...(groups.get(definition.id) ?? []), ...paths])]);
    for (const path of paths) files.set(path, { path, maximumBytes: path === paths[0] ? 2_097_152 : 1_048_576 });
  }
  if (aggregateMembers.length) {
    try {
      for (const file of aggregateProviderMaterialFiles(environment, aggregateMembers)) files.set(file.path, file);
    } catch (error) {
      if (!(error instanceof AggregateProviderTopologyChangedError)) throw error;
      aggregateRestartRequired = true;
    }
  }
  if (files.size > maximumSnapshotFiles) throw new Error("Provider settings file budget exceeded");
  let bytes = 0;
  for (const file of files.values()) {
    try {
      // The main Codex config retains its established shared/symlink contract.
      const metadata = (file.path === join(home, "config.toml") ? statSync : lstatSync)(file.path);
      if (!metadata.isFile() || metadata.size > file.maximumBytes) throw new Error("Provider settings file type or size invalid");
      bytes += metadata.size;
      if (bytes > maximumSnapshotBytes) throw new Error("Provider settings snapshot budget exceeded");
    } catch (error) { if (error?.code !== "ENOENT") throw error; }
  }
  const digests = new Map();
  for (const [provider, paths] of groups) {
    const values = paths.map(path => {
      try {
        const read = path === join(home, "config.toml") ? readCodexConfigFile : readPrivateFileSync;
        const content = read(path, files.get(path).maximumBytes);
        return [path, createHash("sha256").update(content).digest("hex")];
      } catch (error) { if (error?.code === "ENOENT") return [path, "missing"]; throw error; }
    });
    // Registered accounts without a marker are not configured for Codex yet.
    // Keep watching their material paths so adding the marker changes the digest.
    if (configuredProviders.has(provider)) values.push(["provider-web-search", readProviderWebSearchFingerprint(provider, environment)]);
    digests.set(provider, createHash("sha256").update(JSON.stringify(values)).digest("hex"));
  }
  if (aggregateMembers.length && !aggregateRestartRequired) digests.set(aggregateProviderId, readAggregateProviderSettingsFingerprint(environment, aggregateMembers));
  return { fingerprints: [...digests], aggregateRestartRequired };
}

parentPort.on("message", ({ deadline, operation }) => {
  if (operation === "close") { void close(); return; }
  if (stopping) return;
  let phase = "read";
  try {
    const snapshot = withWindowsAclDeadline(deadline, () => {
      const visibleProviders = loadManagedModelProviderDefinitions(environment).map(definition => definition.id);
      const before = fingerprints();
      phase = "validation";
      validateConfiguredModelProviders(environment);
      phase = "read";
      const after = fingerprints();
      if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error("Provider settings changed during validation");
      if (JSON.stringify(visibleProviders) !== JSON.stringify(loadManagedModelProviderDefinitions(environment).map(definition => definition.id))) {
        throw new Error("Provider settings topology changed during validation");
      }
      return { ok: true, visibleProviders, ...after };
    });
    parentPort.postMessage(snapshot);
  } catch { parentPort.postMessage({ ok: false, phase }); }
});
parentPort.postMessage({ ready: true });
