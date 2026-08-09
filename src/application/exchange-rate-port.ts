export interface ExchangeRateSnapshot {
  usdToCny: number;
  effectiveAtMs: number;
  source: "open-er-api" | "ecb" | "cache";
}

export interface ExchangeRatePort {
  resolve(): ExchangeRateSnapshot | null;
}

export type DisplayPriceCurrency = "cny" | "usd";

export function resolvePriceCurrency(
  mode: "cny" | "usd",
): DisplayPriceCurrency {
  return mode;
}

export function priceDisplayNeedsExchangeRate(
  config: {
    priceCurrency: "cny" | "usd";
  },
): boolean {
  return config.priceCurrency === "cny";
}
