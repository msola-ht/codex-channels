import { execFileSync, spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { join } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { initializeUserData } from "../scripts/runtime-config.mjs";
import { readGatewayConfig, writeGatewayConfig } from "../runtime/gateway-config.mjs";
import { inspectManagedServiceStatus } from "../scripts/service-status.mjs";

import { describe, expect, it } from "vitest";

describe("service target query", () => {
  it.each(["systemd", "launchd"] as const)("keeps installed Relay visible through the %s text controller and JSON status with broken config", platform => {
    const shell = platform === "systemd" ? "/bin/sh" : "/bin/zsh";
    if (!existsSync(shell)) return;
    const home = mkdtempSync(join(tmpdir(), "relay-status-"));
    try {
      const bin = join(home, "bin"); mkdirSync(bin);
      const manager = join(bin, platform === "systemd" ? "systemctl" : "launchctl");
      writeFileSync(manager, '#!/bin/sh\nprintf "%s\\n" "$*" >> "$RELAY_REVIEW_LOG"\n'); chmodSync(manager, 0o755);
      const directory = platform === "systemd" ? join(home, ".config", "systemd", "user") : join(home, "Library", "LaunchAgents");
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, platform === "systemd" ? "codex-connect-model-relay.service" : "com.hegenai.codex-model-relay.plist"), "fixture");
      writeFileSync(join(directory, platform === "systemd" ? "codex-connect-webui.service" : "com.hegenai.codex-webui.plist"), "fixture");
      const configPath = join(home, "config.toml"); writeFileSync(configPath, "broken = [");
      const log = join(home, "manager.log");
      const environment = { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, ".config"),
        CODEX_CONNECT_CONFIG_FILE: configPath, NODE_BINARY: process.execPath, SYSTEMCTL_BINARY: manager,
        PATH: `${bin}:/usr/bin:/bin`, RELAY_REVIEW_LOG: log };
      const result = spawnSync(shell, [resolve(`scripts/${platform}-control.sh`), "status", "all"], { env: environment, encoding: "utf8" });
      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(log, "utf8")).toContain("model-relay");
      const json = inspectManagedServiceStatus({ environment, platform: platform === "systemd" ? "linux" : "darwin", target: "all", userId: 1000,
        run: (() => ({ pid: 42, output: [], signal: null, status: 0,
          stdout: platform === "systemd" ? "LoadState=loaded\nActiveState=active\nSubState=running\nMainPID=42\n" : "state = running\npid = 42\n", stderr: "" })) as unknown as typeof spawnSync });
      expect(json.services.map(service => service.target)).toContain("model-relay");
      expect(json.services.map(service => service.target)).toContain("webui");
      expect(readFileSync(log, "utf8")).toContain("webui");
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
  it("starts only an installed enabled Relay and stops it before Gateway even when configuration is invalid", () => {
    const home = mkdtempSync(join(tmpdir(), "relay-target-"));
    const environment = { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, ".config"), CODEX_CONNECT_HOME: join(home, "connect"), CODEX_CONNECT_CONFIG_FILE: join(home, "connect", "config.toml") };
    const query = (order: string): string[] => execFileSync(process.execPath, [resolve("scripts/service-target-query.mjs"), "systemd", "all", order], { env: environment, encoding: "utf8" }).trim().split("\n");
    try {
      initializeUserData({ environment, cwd: home });
      const document = readGatewayConfig(environment.CODEX_CONNECT_CONFIG_FILE);
      document.telegram = { bot_token: "fixture", allowed_user_ids: [1] }; writeGatewayConfig(environment.CODEX_CONNECT_CONFIG_FILE, document);
      const directory = join(environment.XDG_CONFIG_HOME, "systemd", "user"); mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, "codex-connect-model-relay.service"), "fixture");
      expect(query("start")).not.toContain("codex-connect-model-relay.service");
      expect(query("status")).toContain("codex-connect-model-relay.service");
      document.model_relay = { enabled: true }; writeGatewayConfig(environment.CODEX_CONNECT_CONFIG_FILE, document);
      expect(query("start").at(-1)).toBe("codex-connect-model-relay.service");
      writeFileSync(join(directory, "codex-connect-webui.service"), "fixture");
      expect(query("start")).toEqual(["codex-connect-app-server.service", "codex-connect-gateway.service", "codex-connect-model-relay.service", "codex-connect-webui.service"]);
      expect(query("install")).not.toContain("codex-connect-webui.service");
      expect(query("install-stop")).toEqual(["codex-connect-model-relay.service", "codex-connect-gateway.service", "codex-connect-app-server.service"]);
      writeFileSync(environment.CODEX_CONNECT_CONFIG_FILE, "broken = [");
      expect(query("stop")).toEqual(["codex-connect-webui.service", "codex-connect-model-relay.service", "codex-connect-gateway.service", "codex-connect-app-server.service"]);
      expect(query("status")).toContain("codex-connect-model-relay.service");
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
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
  });

  it("rejects an unsupported ordering value", () => {
    const result = spawnSync(
      process.execPath,
      [resolve("scripts/service-target-query.mjs"), "systemd", "all", "invalid-order"],
      { encoding: "utf8" },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("未知服务选择操作");
    expect(result.stdout).toBe("");
  });
});
