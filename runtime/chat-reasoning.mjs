/** Explicit Relay model policies; selecting a field does not assert upstream support. */
export const relayModelReasoningModes = Object.freeze([
  "passthrough", "off", "minimal", "low", "medium", "high", "xhigh", "max",
  "off-reasoning-effort", "off-reasoning-enabled", "off-reasoning-effort-field",
  "off-thinking", "off-enable-thinking", "off-chat-template-thinking", "off-google-thinking-budget", "off-reasoning-enabled-thinking",
]);

/** Managed CLP request snapshot; omitted profiles preserve exact-ID defaults. */
export function resolveClinePassRequestProfile(model, explicitProfile) {
  if (explicitProfile !== undefined) {
    if (explicitProfile !== "standard" && explicitProfile !== "deepseek-flash") {
      throw new Error("CLP 模型请求配置无效");
    }
    return explicitProfile;
  }
  return model === "cline-pass/deepseek-v4.1-flash" ? "deepseek-flash" : "standard";
}

/** Established automatic Chat mapping; no network, credentials or model-name inference. */
export function supportsChatReasoningOff(provider, model) {
  return /^ds-[a-z0-9_-]{1,32}$/u.test(provider) && ["deepseek-flash", "deepseek-v4-pro"].includes(model)
    || /^clp-[a-z0-9_-]{1,32}$/u.test(provider) && model === "cline-pass/deepseek-v4.1-flash";
}
