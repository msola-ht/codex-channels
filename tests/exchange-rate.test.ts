import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import { priceDisplayNeedsExchangeRate } from "../src/application/index.js";
import { RemoteExchangeRate } from "../src/bootstrap/exchange-rate.js";

describe("priceDisplayNeedsExchangeRate", () => {
  it("only enables exchange rates when the global currency is CNY", () => {
    expect(priceDisplayNeedsExchangeRate({ priceCurrency: "cny" })).toBe(true);
    expect(priceDisplayNeedsExchangeRate({ priceCurrency: "usd" })).toBe(false);
  });
});

describe("RemoteExchangeRate", () => {
  it("fetches the USD/CNY rate from the primary source and persists a cache", async () => {
    const cachePath = join(temporaryDirectory(), "exchange-rate.json");
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toContain("open.er-api.com");
      return new Response(JSON.stringify({
        result: "success",
        rates: { USD: 1, CNY: 7.1234 },
      }), { status: 200 });
    });
    const rate = new RemoteExchangeRate({
      cachePath,
      fetchImpl,
      logger: pino({ level: "silent" }),
      now: () => 1_700_000_000_000,
    });

    await rate.refresh();

    expect(rate.resolve()).toEqual({
      usdToCny: 7.1234,
      effectiveAtMs: 1_700_000_000_000,
      source: "open-er-api",
    });
    expect(JSON.parse(readFileSync(cachePath, "utf8"))).toMatchObject({
      version: 1,
      source: "open-er-api",
      usdToCny: 7.1234,
    });
    await rate.close();
  });

  it("falls back to the ECB source and reloads the last valid cache", async () => {
    const directory = temporaryDirectory();
    const cachePath = join(directory, "exchange-rate.json");
    const sourceCalls: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      sourceCalls.push(url);
      if (url.includes("open.er-api")) throw new Error("primary unavailable");
      return new Response(JSON.stringify({
        rates: { USD: 1, CNY: 7.5678 },
      }), { status: 200 });
    });
    const first = new RemoteExchangeRate({
      cachePath,
      fetchImpl,
      logger: pino({ level: "silent" }),
      now: () => 1_700_000_000_000,
    });
    await first.refresh();
    await first.close();

    const reloaded = new RemoteExchangeRate({
      cachePath,
      fetchImpl: vi.fn(),
      logger: pino({ level: "silent" }),
    });
    expect(sourceCalls).toHaveLength(2);
    expect(reloaded.resolve()).toEqual({
      usdToCny: 7.5678,
      effectiveAtMs: 1_700_000_000_000,
      source: "ecb",
    });
    await reloaded.close();
  });

  it("rejects invalid or out-of-range rates without overriding the cache", async () => {
    const cachePath = join(temporaryDirectory(), "exchange-rate.json");
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      rates: { CNY: "not-a-number" },
    }), { status: 200 }));
    const rate = new RemoteExchangeRate({
      cachePath,
      fetchImpl,
      logger: pino({ level: "silent" }),
      now: () => 1_700_000_000_000,
    });

    await expect(rate.refresh()).rejects.toThrow(/USD\/CNY/u);
    expect(rate.resolve()).toBeNull();
    await rate.close();
  });
});

function temporaryDirectory(): string {
  return mkdtempSync(join(tmpdir(), "codexc-exchange-rate-"));
}
