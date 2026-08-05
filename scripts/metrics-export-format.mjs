import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { readGatewayConfig } from "../runtime/gateway-config.mjs";
import { resolvePriceCurrency } from "../dist/application/index.js";
import { formatTokenCount } from "../dist/surfaces/token-format.js";
import {
  locateUserConfig,
  resolveConfiguredPath,
} from "./runtime-config.mjs";

export { formatTokenCount };

export function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function loadDisplayContext(environment) {
  const { configPath, dataDir } = locateUserConfig(environment);
  const document = readGatewayConfig(configPath);
  const display = isRecord(document.display) ? document.display : {};
  const storage = isRecord(document.storage) ? document.storage : {};
  const stateDatabasePath = resolveConfiguredPath(
    typeof storage.database_path === "string" ? storage.database_path : undefined,
    dataDir,
    "data/gateway.sqlite3",
  );
  return {
    priceCurrency: display.price_currency ?? "auto",
    priceCurrencyByProvider: isRecord(display.price_currency_by_provider)
      ? display.price_currency_by_provider
      : {},
    exchangeRate: loadExchangeRate(dirname(stateDatabasePath)),
  };
}

export function loadExchangeRate(directory) {
  try {
    const parsed = JSON.parse(
      readFileSync(join(directory, "exchange-rate.json"), "utf8"),
    );
    if (
      !isRecord(parsed)
      || parsed.version !== 1
      || !["open-er-api", "ecb", "cache"].includes(parsed.source)
      || !Number.isSafeInteger(parsed.effectiveAtMs)
      || parsed.effectiveAtMs <= 0
    ) {
      return null;
    }
    const rate = Number(parsed.usdToCny);
    if (!Number.isFinite(rate) || rate <= 0) return null;
    return {
      usdToCny: rate,
      effectiveAtMs: parsed.effectiveAtMs,
      source: parsed.source,
    };
  } catch {
    return null;
  }
}

export function convertCostToCny(nanos, currency, provider, display) {
  if (
    display == null
    || nanos === null
    || nanos === undefined
    || currency !== "USD"
    || !display.exchangeRate
  ) {
    return null;
  }
  const mode = display.priceCurrencyByProvider[provider]
    ?? display.priceCurrency
    ?? "auto";
  if (resolvePriceCurrency(mode, provider) !== "cny") return null;
  const converted = Math.round(nanos * display.exchangeRate.usdToCny);
  return Number.isSafeInteger(converted) ? converted : null;
}

export function enrichCosts(value, display) {
  if (value === null || value === undefined) return value;
  const currency = value.pricingCurrency
    ?? value.pricing?.currency
    ?? null;
  const provider = value.provider ?? null;
  const toCny = (nanos) => convertCostToCny(nanos, currency, provider, display);
  return {
    ...value,
    totalCostCnyNanos: toCny(value.totalCostNanos),
    inputCostCnyNanos: toCny(value.inputCostNanos),
    cachedInputCostCnyNanos: toCny(value.cachedInputCostNanos),
    outputCostCnyNanos: toCny(value.outputCostNanos),
  };
}

export function formatCost(aggregate, display = null) {
  if (
    aggregate.totalCostNanos === null
    || aggregate.pricingCurrency === null
    || aggregate.pricingCurrency === undefined
  ) {
    return "未知";
  }
  const converted = convertCostToCny(
    aggregate.totalCostNanos,
    aggregate.pricingCurrency,
    aggregate.provider,
    display,
  );
  const nanos = converted ?? aggregate.totalCostNanos;
  const currency = converted === null ? aggregate.pricingCurrency : "CNY";
  const amount = nanos / 1_000_000_000;
  const symbol = currency === "CNY"
    ? "¥"
    : currency === "USD"
      ? "$"
      : `${currency} `;
  return `${symbol}${amount.toFixed(6).replace(/0+$/u, "").replace(/\.$/u, "")}`;
}

export function exchangeRateLine(display) {
  if (!display?.exchangeRate || display.exchangeRate.source === "cache") {
    return null;
  }
  const rate = display.exchangeRate;
  return `汇率：1 USD ≈ ${rate.usdToCny.toFixed(4)} CNY（${rate.source} · ${formatLocalTime(rate.effectiveAtMs)}）`;
}

export function formatLocalTime(ms) {
  const date = new Date(ms);
  const pad = (value) => String(value).padStart(2, "0");
  return [
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`,
  ].join(" ");
}

export function formatCurrencyNanos(
  value,
  currency,
  display = null,
  provider = null,
) {
  const converted = convertCostToCny(value, currency, provider, display);
  const nanos = converted ?? value;
  const target = converted === null ? currency : "CNY";
  const amount = (nanos / 1_000_000_000).toFixed(6)
    .replace(/0+$/u, "")
    .replace(/\.$/u, "");
  const symbol = target === "CNY" ? "¥" : target === "USD" ? "$" : `${target} `;
  return `${symbol}${amount}`;
}

export function formatDuration(value) {
  return value === null ? "未知" : `${Math.round(value)}ms`;
}

export function markdownCell(value) {
  return String(value).replaceAll("|", "\\|").replaceAll("\n", " ");
}

export function csvCell(value) {
  if (value === null || value === undefined) return "";
  const text = String(value);
  return /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}
