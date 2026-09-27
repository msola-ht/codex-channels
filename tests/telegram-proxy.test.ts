import { HttpsProxyAgent } from "https-proxy-agent";
import { describe, expect, it, vi } from "vitest";

import {
  cleanupTelegramSurfaceTestDirectories,
  createTelegramSurfaceFixture,
} from "./telegram-surface-test-fixture.js";

describe("Telegram proxy lifecycle", () => {
  it("owns a reusable proxy agent and releases it on shutdown", async () => {
    const directories: string[] = [];
    const destroy = vi.spyOn(HttpsProxyAgent.prototype, "destroy");
    const { surface } = createTelegramSurfaceFixture(
      directories, vi.fn(), vi.fn(), {}, vi.fn(), vi.fn(),
      undefined, false, undefined, "http://127.0.0.1:7897",
    );
    try {
      await surface.stop();
      expect(destroy).toHaveBeenCalledTimes(1);
      const agent = destroy.mock.contexts[0];
      expect(agent).toBeInstanceOf(HttpsProxyAgent);
      expect(agent).toHaveProperty("keepAlive", true);
    } finally {
      destroy.mockRestore();
      cleanupTelegramSurfaceTestDirectories(directories);
    }
  });
});
