import { UserFacingError } from "../conversation-core/index.js";
import type { CloudUsageQuery } from "./account-port.js";

export function parseCloudUsageQuery(text: string): CloudUsageQuery | undefined {
  if (!text.trim()) return undefined;
  const parts = text.trim().split(/\s+/u);
  const range = parts.shift();
  const fail = (): never => { throw new UserFacingError("usage.arguments", "用法：/usage [24h|7d|30d] [refresh]"); };
  if (range !== "24h" && range !== "7d" && range !== "30d") return fail();
  const query: CloudUsageQuery = { range };
  if (parts[0] === "account") {
    parts.shift();
    const provider = parts.shift();
    // This is a bounded identity selector, not an account definition. The use
    // case matches it against the authoritative current provider before I/O.
    if (!provider || !/^[A-Za-z0-9_-]{1,64}$/u.test(provider)) return fail();
    query.expectedProvider = provider;
  }
  if (parts[0] === "refresh") { parts.shift(); query.refresh = true; }
  if (parts.length) return fail();
  return query;
}
