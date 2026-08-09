import { describe, expect, it, vi } from "vitest";

import { consumeQueryToken } from "../webui/src/lib/query-token.js";

describe("WebUI query token bootstrap", () => {
  it("stores a query token and removes it from the visible URL", () => {
    const storeToken = vi.fn();
    const replaceUrl = vi.fn();

    expect(consumeQueryToken({
      currentUrl: "https://metrics.example.com/?range=24h&token=secret-value#/requests",
      storeToken,
      replaceUrl,
    })).toBe(true);

    expect(storeToken).toHaveBeenCalledWith("secret-value");
    expect(replaceUrl).toHaveBeenCalledWith("/?range=24h#/requests");
  });

  it("ignores a missing token without rewriting the URL", () => {
    const storeToken = vi.fn();
    const replaceUrl = vi.fn();

    expect(consumeQueryToken({
      currentUrl: "https://metrics.example.com/#/threads",
      storeToken,
      replaceUrl,
    })).toBe(false);
    expect(storeToken).not.toHaveBeenCalled();
    expect(replaceUrl).not.toHaveBeenCalled();
  });
});
