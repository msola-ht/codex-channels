import { afterEach, describe, expect, it, vi } from "vitest";

import { consumeQueryToken } from "../webui/src/lib/query-token.js";
import { getToken, setToken } from "../webui/src/lib/token-storage.js";

describe("WebUI query token bootstrap", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("stores a query token and removes it from the visible URL", () => {
    const storeToken = vi.fn(() => true);
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
    const storeToken = vi.fn(() => true);
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
    const storeToken = vi.fn(() => true);
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

    expect(setToken("secret-value")).toBe(true);

    expect(values.get("codex-webui:token")).toBe("secret-value");
    expect(getToken()).toBe("secret-value");
    expect(sessionStorage.setItem).not.toHaveBeenCalled();
  });

  it("clears both URL token locations before reporting storage failure", () => {
    const steps: string[] = [];
    expect(consumeQueryToken({
      currentUrl: "https://metrics.example.com/?token=fixture#/requests?token=other&range=7d",
      replaceUrl: url => { steps.push(url); },
      storeToken: () => { steps.push("store"); return false; },
      onStorageFailure: () => { steps.push("failed"); },
    })).toBe(false);
    expect(steps).toEqual(["/#/requests?range=7d", "store", "failed"]);
  });

  it("reports unavailable storage instead of claiming an in-memory login", () => {
    const unavailable = () => { throw new Error("storage unavailable"); };
    vi.stubGlobal("localStorage", { getItem: unavailable, setItem: unavailable, removeItem: unavailable });
    vi.stubGlobal("sessionStorage", { getItem: unavailable, setItem: unavailable, removeItem: unavailable });
    expect(setToken("synthetic-token")).toBe(false);
    expect(getToken()).toBe(null);
  });

  it("uses the session fallback only when API reads can retrieve the same token", () => {
    let old: string | null = "old-token";
    let stored: string | null = null;
    vi.stubGlobal("localStorage", {
      getItem: () => old,
      setItem: () => { throw new Error("quota"); },
      removeItem: () => { old = null; },
    });
    vi.stubGlobal("sessionStorage", { getItem: () => stored, setItem: (_key: string, value: string) => { stored = value; } });
    expect(setToken("new-token")).toBe(true);
    expect(getToken()).toBe("new-token");
    old = "old-token";
    vi.stubGlobal("localStorage", { getItem: () => old, setItem: () => { throw new Error("blocked"); }, removeItem: () => { throw new Error("blocked"); } });
    expect(setToken("another-token")).toBe(false);
    expect(getToken()).toBe("old-token");
  });
});
