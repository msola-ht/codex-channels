import { describe, expect, it } from "vitest";

import {
  defaultServiceTarget,
  parseServiceTarget,
  serviceIdentifiers,
  serviceTargetIncludes,
  serviceTargetUsage,
} from "../runtime/service-targets.mjs";

describe("service target catalog", () => {
  it("keeps all service ordering explicit for start and stop", () => {
    expect(serviceIdentifiers("systemd", "all", "start")).toEqual([
      "codex-connect-app-server.service",
      "codex-connect-gateway.service",
      "codex-connect-model-relay.service",
      "codex-connect-webui.service",
    ]);
    expect(serviceIdentifiers("launchd", "all", "stop")).toEqual([
      "com.hegenai.codex-webui",
      "com.hegenai.codex-model-relay",
      "com.hegenai.codex-gateway",
      "com.hegenai.codex-app-server",
    ]);
    expect(serviceIdentifiers("windows", "all", "start")).toEqual([
      "Codex Connect App Server",
      "Codex Connect Gateway",
      "Codex Connect Model Relay",
      "Codex Connect WebUI",
    ]);
  });

  it("owns public defaults and App Server inclusion semantics", () => {
    expect(serviceTargetUsage).toBe("gateway|app-server|webui|model-relay|all");
    expect(defaultServiceTarget("restart")).toBe("all");
    expect(defaultServiceTarget("start")).toBe("all");
    expect(serviceTargetIncludes("all", "app-server")).toBe(true);
    expect(serviceTargetIncludes("all", "webui")).toBe(true);
    expect(serviceTargetIncludes("all", "model-relay")).toBe(true);
    expect(serviceTargetIncludes("gateway", "app-server")).toBe(false);
    expect(parseServiceTarget("webui")).toBe("webui");
    expect(() => parseServiceTarget("unknown")).toThrow("服务目标必须是");
  });
});
