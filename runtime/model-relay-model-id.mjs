/** Public Relay IDs always qualify the upstream model with its exact provider. */
export function parseRelayModelId(value) {
  if (typeof value !== "string") return null;
  const slash = value.indexOf("/");
  if (slash < 1) return null;
  const provider = value.slice(0, slash), model = value.slice(slash + 1);
  if (!/^[A-Za-z0-9_-]{1,64}$/u.test(provider) || !model.length || model.length > 200
    || model.trim() !== model || /[\p{Cc}\p{Cf}\p{Cs}]/u.test(model)) return null;
  return { provider, model };
}

/** Strip only the documented CLP wire prefix; never infer an upstream identifier. */
export function relayModelId(provider, upstreamModel) {
  const model = provider.startsWith("clp-") && upstreamModel.startsWith("cline-pass/")
    ? upstreamModel.slice("cline-pass/".length) : upstreamModel;
  return `${provider}/${model}`;
}
