import { execFileSync, spawnSync } from "node:child_process";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

describe("service target query", () => {
  it("resolves identifiers by canonical target instead of catalog position", () => {
    const query = (platform: "systemd" | "launchd", target: string): string =>
      execFileSync(
        process.execPath,
        [resolve("scripts/service-target-query.mjs"), platform, target, "start"],
        { encoding: "utf8" },
      ).trim();

    expect(query("systemd", "app-server"))
      .toBe("codex-connect-app-server.service");
    expect(query("systemd", "gateway"))
      .toBe("codex-connect-gateway.service");
    expect(query("launchd", "webui"))
      .toBe("com.hegenai.codex-webui");
    expect(query("launchd", "center"))
      .toBe("com.hegenai.codex-center");
  });

  it("rejects an unsupported ordering value", () => {
    const result = spawnSync(
      process.execPath,
      [resolve("scripts/service-target-query.mjs"), "systemd", "all", "invalid-order"],
      { encoding: "utf8" },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("服务顺序必须是 start 或 stop");
    expect(result.stdout).toBe("");
  });
});
