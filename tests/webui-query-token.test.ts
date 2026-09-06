import { afterEach, describe, expect, it, vi } from "vitest";

import { consumeQueryToken } from "../webui/src/lib/query-token.js";
import { getToken, setToken } from "../webui/src/lib/token-storage.js";

describe("WebUI query token bootstrap", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

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

  it("stores a token from a HashRouter route and removes it from the hash", () => {
    const storeToken = vi.fn();
    const replaceUrl = vi.fn();

    expect(consumeQueryToken({
      currentUrl: "https://metrics.example.com/#/settings?token=secret-value&range=24h",
      storeToken,
      replaceUrl,
    })).toBe(true);

    expect(storeToken).toHaveBeenCalledWith("secret-value");
    expect(replaceUrl).toHaveBeenCalledWith("/#/settings?range=24h");
  });

  it("persists login tokens and keeps the persistent value when session cleanup fails", () => {
    const values = new Map<string, string>();
    const localStorage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
      removeItem: (key: string) => { values.delete(key); },
    };
    const sessionStorage = {
      getItem: () => null,
      setItem: vi.fn(),
      removeItem: () => { throw new Error("session storage unavailable"); },
    };
    vi.stubGlobal("localStorage", localStorage);
    vi.stubGlobal("sessionStorage", sessionStorage);

    setToken("secret-value");

    expect(values.get("codex-webui:token")).toBe("secret-value");
    expect(getToken()).toBe("secret-value");
    expect(sessionStorage.setItem).not.toHaveBeenCalled();
  });
});
