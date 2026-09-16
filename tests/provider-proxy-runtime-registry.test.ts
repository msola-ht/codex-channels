import { describe, expect, it } from "vitest";

import { ProviderProxyRuntimeRegistry } from "../runtime/provider-proxy-runtime-registry.mjs";

describe("ProviderProxyRuntimeRegistry", () => {
  it("shares one in-flight startup for the same proxy key", async () => {
    let starts = 0;
    let finishStart: (() => void) | undefined;
    const registry = new ProviderProxyRuntimeRegistry(async (key, upstream) => {
      starts += 1;
      await new Promise<void>((resolve) => {
        finishStart = resolve;
      });
      return {
        baseUrl: `http://${key}.test`,
        proxy: { key, upstream },
      };
    });

    const first = registry.ensure("ocg", "first");
    const second = registry.ensure("ocg", "second");
    await Promise.resolve();

    expect(starts).toBe(1);
    finishStart?.();
    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(secondResult.proxy).toBe(firstResult.proxy);
    expect(secondResult.proxy).toEqual({ key: "ocg", upstream: "first" });
    expect(registry.get("ocg")).toBeDefined();
    expect(registry.values()).toHaveLength(1);
    expect(registry.remove(firstResult.proxy)).toBe(true);
    expect(registry.get("ocg")).toBeUndefined();
    expect(registry.values()).toEqual([]);
  });

  it("clears a failed startup so the same key can be retried", async () => {
    let starts = 0;
    const registry = new ProviderProxyRuntimeRegistry(async (key) => {
      starts += 1;
      if (starts === 1) throw new Error("start failed");
      return { baseUrl: `http://${key}.test`, proxy: { key } };
    });

    await expect(registry.ensure("openai", undefined)).rejects.toThrow("start failed");
    await expect(registry.ensure("openai", undefined)).resolves.toMatchObject({
      baseUrl: "http://openai.test",
    });
    expect(starts).toBe(2);
  });

  it("keeps a shared proxy in use until every provider releases it", () => {
    const registry = new ProviderProxyRuntimeRegistry(async (key) => ({
      baseUrl: `http://${key}.test`,
      proxy: { key },
    }));

    registry.addUser("ocg", "ocg-first");
    registry.addUser("ocg", "ocg-second");
    registry.removeUser("ocg", "ocg-first");
    expect(registry.hasUsers("ocg")).toBe(true);

    registry.removeUser("ocg", "ocg-second");
    expect(registry.hasUsers("ocg")).toBe(false);
  });
});
