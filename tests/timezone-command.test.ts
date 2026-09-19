import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

// @ts-expect-error JavaScript CLI helper intentionally has no declaration file.
import { parseTimezoneCommandArgs, runTimezoneCommand } from "../scripts/timezone-command.mjs";
import { loadGatewaySettings } from "../scripts/config-management.mjs";
import { readGatewayConfig } from "../runtime/gateway-config.mjs";
import { initializeUserData } from "../scripts/runtime-config.mjs";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "codexc-timezone-"));
  roots.push(root);
  const environment = {
    ...process.env,
    CODEX_CONNECT_HOME: join(root, ".codex-connect"),
    CODEX_CONNECT_CONFIG_FILE: "",
  };
  const initialized = initializeUserData({ environment, cwd: root });
  return { environment, configPath: initialized.configPath };
}

function captureOutput() {
  const chunks: string[] = [];
  return {
    stream: {
      isTTY: false,
      write: (text: string) => {
        chunks.push(text);
        return true;
      },
    },
    text: () => chunks.join(""),
  };
}

describe("codexc timezone", () => {
  it("rejects non-IANA names, unknown zones and conflicting arguments", () => {
    expect(() => parseTimezoneCommandArgs(["Los Angeles"])).toThrow(/时区名称无效/u);
    expect(() => parseTimezoneCommandArgs(["--system", "Asia/Shanghai"]))
      .toThrow(/不能与时区名称同时使用/u);
    expect(() => parseTimezoneCommandArgs(["--system", "--system"]))
      .toThrow(/只能出现一次/u);
    expect(() => parseTimezoneCommandArgs(["-x"])).toThrow(/未知参数/u);
    expect(() => parseTimezoneCommandArgs(["Asia/Shanghai"], {
      exists: (path: string) => path.endsWith("/UTC"),
    })).toThrow(/时区库中没有/u);
    expect(parseTimezoneCommandArgs(["Asia/Shanghai"], {
      exists: () => true,
    })).toEqual({ action: "set", timezone: "Asia/Shanghai", json: false });
    expect(parseTimezoneCommandArgs([], { exists: () => true }))
      .toEqual({ action: "prompt", json: false });
    expect(parseTimezoneCommandArgs(["--json"], { exists: () => true }))
      .toEqual({ action: "status", json: true });
  });

  it("writes and clears [codex].timezone without touching the system", async () => {
    const fixture = createFixture();
    const saved = captureOutput();

    await expect(runTimezoneCommand(["America/Los_Angeles"], {
      environment: fixture.environment,
      output: saved.stream,
    })).resolves.toMatchObject({
      action: "saved",
      timezone: "America/Los_Angeles",
    });
    expect(readGatewayConfig(fixture.configPath).codex ?? {}).toMatchObject({
      timezone: "America/Los_Angeles",
    });
    expect(loadGatewaySettings(fixture.environment).system.appServerTimezone)
      .toBe("America/Los_Angeles");
    expect(saved.text()).toContain("codexc service restart app-server");

    const cleared = captureOutput();
    await expect(runTimezoneCommand(["--system"], {
      environment: fixture.environment,
      output: cleared.stream,
    })).resolves.toMatchObject({ action: "saved", timezone: null });
    expect(readGatewayConfig(fixture.configPath).codex ?? {})
      .not.toHaveProperty("timezone");
    expect(cleared.text()).toContain("已恢复系统时区");
  });

  it("reports the current value in non-interactive terminals", async () => {
    const fixture = createFixture();
    const output = captureOutput();

    await expect(runTimezoneCommand([], {
      environment: fixture.environment,
      output: output.stream,
    })).resolves.toMatchObject({ action: "status", timezone: null });
    expect(output.text()).toContain("沿用系统时区");
  });
});
