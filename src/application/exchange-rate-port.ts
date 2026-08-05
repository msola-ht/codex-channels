export interface ExchangeRateSnapshot {
  usdToCny: number;
  effectiveAtMs: number;
  source: "open-er-api" | "ecb" | "cache";
}

export interface ExchangeRatePort {
  resolve(): ExchangeRateSnapshot | null;
}

export type PriceCurrencyMode = "auto" | "cny" | "usd";
export type DisplayPriceCurrency = "cny" | "usd";

export function resolvePriceCurrency(
  mode: PriceCurrencyMode,
  provider: string | null | undefined,
): DisplayPriceCurrency {
  if (mode === "cny") return "cny";
  if (mode === "usd") return "usd";
  return provider === "deepseek" ? "cny" : "usd";
}

export function priceDisplayNeedsExchangeRate(
  config: {
    priceCurrency: PriceCurrencyMode;
    priceCurrencyByProvider: Readonly<Record<string, PriceCurrencyMode>>;
  },
  activeProviders: readonly string[],
): boolean {
  return activeProviders.some((provider) => resolvePriceCurrency(
    config.priceCurrencyByProvider[provider] ?? config.priceCurrency,
    provider,
  ) === "cny");
}
