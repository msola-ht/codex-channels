export interface ExchangeRateSnapshot {
  usdToCny: number;
  effectiveAtMs: number;
  source: "open-er-api" | "ecb" | "cache";
}

export interface ExchangeRatePort {
  resolve(): ExchangeRateSnapshot | null;
}
