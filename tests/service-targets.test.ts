import { describe, expect, it } from "vitest";

import {
  defaultServiceTarget,
  parseServiceTarget,
  serviceIdentifiers,
  serviceTargetIncludes,
  serviceTargetUsage,
} from "../runtime/service-targets.mjs";

describe("service target catalog", () => {
  it("keeps core service ordering explicit for start and stop", () => {
    expect(serviceIdentifiers("systemd", "all", "start")).toEqual([
      "codex-connect-app-server.service",
      "codex-connect-gateway.service",
    ]);
    expect(serviceIdentifiers("launchd", "all", "stop")).toEqual([
      "com.hegenai.codex-gateway",
      "com.hegenai.codex-app-server",
    ]);
  });

  it("owns public defaults and App Server inclusion semantics", () => {
    expect(serviceTargetUsage).toBe("gateway|app-server|webui|center|all");
    expect(defaultServiceTarget("restart")).toBe("gateway");
    expect(defaultServiceTarget("start")).toBe("all");
    expect(serviceTargetIncludes("all", "app-server")).toBe(true);
    expect(serviceTargetIncludes("gateway", "app-server")).toBe(false);
    expect(parseServiceTarget("webui")).toBe("webui");
    expect(() => parseServiceTarget("unknown")).toThrow("服务目标必须是");
  });
});
