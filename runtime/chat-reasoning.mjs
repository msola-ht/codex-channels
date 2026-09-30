/** Exact verified Chat capability; no network, credentials or model-name inference. */
export function supportsChatReasoningOff(provider, model) {
  return /^ds-[a-z0-9_-]{1,32}$/u.test(provider) && ["deepseek-flash", "deepseek-v4-pro"].includes(model)
    || /^clp-[a-z0-9_-]{1,32}$/u.test(provider) && model === "cline-pass/deepseek-v4.1-flash";
}
