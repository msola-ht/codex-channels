import { ModelRelayMaterialReader } from "./model-relay-material-reader.mjs";

/** One isolated reader, at most eight retained checks, no stale policy cache. */
export function createRelayMetricAuthorization(configPath, environment = process.env) {
  const reader = new ModelRelayMaterialReader(configPath, environment, "metrics");
  let pending = 0;
  let reading;
  let closed = false;
  const authorize = async (sample, signal) => {
    if (closed || signal?.aborted) return "closing";
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
  authorize.close = async () => { closed = true; await reader.close(); };
  return authorize;
}
