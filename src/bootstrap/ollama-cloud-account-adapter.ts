import { isOllamaCloudAccountProvider } from "../../runtime/ollama-cloud-accounts.mjs";
import { loadConfiguredProviderCredential } from "../../runtime/model-provider-runtime.mjs";
import type { ManagedModelProviderId } from "../../runtime/model-provider-definitions.mjs";
import type { ProviderAccountAdapter, ProviderAccountUsage } from "../application/index.js";
import { AccountQuery } from "./account-query.js";

const unitsPerDollar = 1_000_000_000n;
const maximumUnits = 999_999_999_999n * unitsPerDollar + unitsPerDollar - 1n;

// A private wrapper distinguishes numeric JSON tokens from upstream strings/objects.
class UsdAmount {
  constructor(readonly units: bigint) {}
}

export function createOllamaCloudAccountAdapter(options: {
  provider: ManagedModelProviderId;
  environment?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}): ProviderAccountAdapter {
  if (!isOllamaCloudAccountProvider(options.provider)) throw new Error("Ollama Cloud 账户身份无效");
  return {
    provider: options.provider,
    async accountUsage(signal, beforeSubmit) {
      const query = new AccountQuery("Ollama Cloud", signal, beforeSubmit);
      return query.run(async () => {
        const credential = loadConfiguredProviderCredential(options.provider, options.environment ?? process.env);
        const { body } = await query.json(options.fetchImpl ?? fetch, "https://ollama.com/api/balance", credential.apiKey, "balance", {
          parseJson: parseBalanceJson,
        });
        return balanceUsage(body, options.provider);
      });
    },
  };
}

function parseBalanceJson(text: string): unknown {
  return JSON.parse(text, (key: string, value: unknown, context?: { source?: string }): unknown => {
    if (key !== "balance_usd") return value;
    // Use the source token, never the already rounded IEEE-754 value.
    if (typeof value !== "number" || typeof context?.source !== "string" || context.source.length > 64) {
      throw new Error("Ollama 余额金额缺少精确数字表示");
    }
    const match = /^(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/u.exec(context.source);
    if (!match) throw new Error("Ollama 余额金额必须是非负数");
    const exponent = Number(match[3] ?? "0");
    const fraction = match[2] ?? "";
    const scale = fraction.length - exponent;
    if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 30 || scale > 9) throw new Error("Ollama 余额金额精度不受支持");
    const units = BigInt(`${match[1]}${fraction}`) * 10n ** BigInt(9 - scale);
    if (units > maximumUnits) throw new Error("Ollama 余额金额超出范围");
    return new UsdAmount(units);
  }) as unknown;
}

function balanceUsage(value: unknown, provider: string): Extract<ProviderAccountUsage, { kind: "balance" }> {
  const body = record(value);
  const included = record(body.included).balance_usd;
  const purchased = record(body.purchased).balance_usd;
  // Legacy session/weekly plans have no USD included balance; never invent zero.
  if (!(included instanceof UsdAmount) || !(purchased instanceof UsdAmount)) throw new Error("Ollama 余额响应缺少 USD 金额");
  const total = included.units + purchased.units;
  if (total > maximumUnits) throw new Error("Ollama 余额合计超出范围");
  return { kind: "balance", provider, available: true, balances: [{
    currency: "USD", totalBalance: decimal(total),
    grantedBalance: decimal(included.units), toppedUpBalance: decimal(purchased.units),
  }] };
}

function decimal(units: bigint): string {
  const fraction = (units % unitsPerDollar).toString().padStart(9, "0").replace(/0+$/u, "");
  return `${units / unitsPerDollar}${fraction ? `.${fraction}` : ""}`;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Ollama 余额响应结构无效");
  return value as Record<string, unknown>;
}
