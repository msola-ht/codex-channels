import { ModelRelayMaterialReader } from "./model-relay-material-reader.mjs";

/** One isolated reader, at most eight retained checks, no stale policy cache. */
export function createRelayMetricAuthorization(configPath, environment = process.env) {
  const reader = new ModelRelayMaterialReader(configPath, environment, "metrics");
  let pending = 0;
  let reading;
  let preparation;
  let prepared = false;
  let closed = false;
  const authorize = async (sample, signal) => {
    if (closed || signal?.aborted) return "closing";
    if (!prepared) return "invalid_sample";
    if (pending >= 8) return "queue_full";
    pending++;
    try {
      // A newly arrived sample must not reuse a read begun before its issuance.
      await reading?.catch(() => {});
      if (closed || signal?.aborted) return "closing";
      reading ??= reader.read().finally(() => { reading = undefined; });
      const snapshot = await reading;
      if (closed || signal?.aborted) return "closing";
      const caller = snapshot.callers.find(value => value.caller_id === sample.callerId && value.key_id === sample.keyId
        && value.provider === sample.provider && sample.credentialGeneration <= value.credential_generation);
      if (!caller) return "invalid_sample";
      return snapshot.providers.includes(sample.provider) ? undefined : "unknown_provider";
    } catch { return "invalid_sample"; }
    finally { pending--; }
  };
  authorize.prepare = () => {
    if (closed) return Promise.reject(new Error("Relay metric authorization closed"));
    // Discard the initialization snapshot; every sample still needs a fresh read.
    // Keep a failed preparation terminal rather than silently retrying startup.
    preparation ??= reader.read().then(() => {
      if (closed) throw new Error("Relay metric authorization closed");
      prepared = true;
    });
    return preparation;
  };
  authorize.close = async () => { closed = true; await reader.close(); };
  return authorize;
}
