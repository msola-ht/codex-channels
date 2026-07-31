export function formatProviderLabel(provider: string): string {
  if (provider === "openai") return "OpenAI";
  if (provider === "deepseek") return "DeepSeek";
  const normalized = provider.replace(/\s+/gu, " ").trim();
  return normalized ? normalized.slice(0, 64) : "未知 Provider";
}
