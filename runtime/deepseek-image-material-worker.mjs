import { parentPort, workerData } from "node:worker_threads";
import { readAppServerProviderSettingsFingerprint } from "./app-server-supervisor.mjs";
import { loadConfiguredManagedProviderMaterial } from "./model-provider-managed-runtime.mjs";
import { withWindowsAclDeadline, closeWindowsAclBridge, waitForWindowsAclBridgeExit } from "./windows-acl-bridge.mjs";

if (!parentPort) throw new Error("Internal DeepSeek image worker requires a parent");
let stopping = false;
async function close() {
  if (stopping) return;
  stopping = true;
  try { await closeWindowsAclBridge({ timeoutMs: 1_000 }); }
  catch { await waitForWindowsAclBridgeExit(); }
  parentPort.close();
}
parentPort.on("message", request => {
  if (request?.operation === "close") { void close(); return; }
  if (stopping) return;
  try {
    if (request?.operation !== "read") throw new Error("DeepSeek image material operation invalid");
    parentPort.postMessage(withWindowsAclDeadline(request.deadline, readMaterials));
  } catch {
    parentPort.postMessage({ ok: false });
  }
});
parentPort.postMessage({ ready: true });

function readMaterials() {
  const { provider, environment } = workerData;
  if (typeof provider !== "string" || !/^ds-[a-z0-9_-]{1,32}$/u.test(provider)) {
    throw new Error("DeepSeek image provider invalid");
  }
  const before = readAppServerProviderSettingsFingerprint(provider, environment);
  const material = loadConfiguredManagedProviderMaterial(provider, environment);
  const after = readAppServerProviderSettingsFingerprint(provider, environment);
  if (before !== after) throw new Error("DeepSeek image materials changed during read");
  return { ok: true, material, settingsFingerprint: before };
}
