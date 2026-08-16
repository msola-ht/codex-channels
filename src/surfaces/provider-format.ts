export function formatProviderLabel(provider: string): string {
  if (provider === "openai") return "OpenAI";
  if (provider === "deepseek") return "DeepSeek";
  if (provider === "opencode-go") return "OpenCode Go";
  const normalized = provider.replace(/\s+/gu, " ").trim();
  return normalized ? normalized.slice(0, 64) : "未知提供商";
}

export function formatCodexProviderLabel(provider?: string): string {
  return provider === undefined || provider === "openai"
    ? "OpenAI 官方"
    : formatProviderLabel(provider);
}
