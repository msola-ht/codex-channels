/** Shared request stages, aligned with the locked Codex 0.162.1 defaults.
 * Generation has no total deadline. Preparation, protocol progress and delivery
 * are separate operations; outer local proxies must not restart upstream clocks.
 */
export const modelRequestPolicy = Object.freeze({
  preparationTimeoutMs: 30_000,
  headersTimeoutMs: 300_000,
  streamIdleTimeoutMs: 300_000,
  websocketConnectTimeoutMs: 15_000,
  bodyReadTimeoutMs: 300_000,
  errorBodyTimeoutMs: 5_000,
  deliveryTimeoutMs: 30_000,
  terminalDeliveryTimeoutMs: 5_000,
});

/** Validate only the model timeout contract, never infer authentication or routing. */
export function assertProviderModelRequestPolicy(provider, requireExplicit = false) {
  if (!provider || typeof provider !== "object" || Array.isArray(provider)) {
    throw new Error("Codex Provider 超时配置缺失或无效");
  }
  for (const [key, expected] of Object.entries(providerModelRequestTimeouts())) {
    const value = provider[key];
    if (value === undefined || value === null) {
      if (!requireExplicit) continue;
    } else if (value === expected) continue;
    throw new Error(`Codex Provider 的 ${key} 与统一请求策略冲突，应为 ${expected}；请检查用户、Profile 或受管配置`);
  }
}

/** Startup overrides for non-built-in providers; OpenAI uses the locked built-in defaults. */
export function providerModelRequestTimeouts() {
  return {
    stream_idle_timeout_ms: modelRequestPolicy.streamIdleTimeoutMs,
    websocket_connect_timeout_ms: modelRequestPolicy.websocketConnectTimeoutMs,
  };
}
