import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { readGatewayConfig } from "../runtime/gateway-config.mjs";
// @ts-expect-error JavaScript CLI helper intentionally has no declaration file.
import { runDebugSetup } from "../scripts/debug-setup.mjs";
import { initializeUserData } from "../scripts/runtime-config.mjs";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("Debug setup", () => {
  it.each([
    ["enabled", "debug", true],
    ["disabled", "info", false],
  ] as const)("writes %s as the global logging level", async (
    selected,
    expectedLevel,
    enabled,
  ) => {
    const fixture = createFixture();
    const output: string[] = [];
    const prompts = {
      select: vi.fn(async () => selected),
      isCancel: () => false,
    };

    const expectedActivation = enabled
      ? {
          activation: "restart-gateway",
          activationResult: {
            status: "restart",
            target: "gateway",
            commands: ["codexc service restart gateway"],
          },
        }
      : {
          activation: "none",
          activationResult: {
            status: "none",
            target: "none",
            commands: [],
          },
        };
    await expect(runDebugSetup({
      environment: fixture.environment,
      output: { write: (value: string) => output.push(value) },
      prompts,
    })).resolves.toEqual({
      enabled,
      configPath: fixture.configPath,
      ...expectedActivation,
    });

    expect(readGatewayConfig(fixture.configPath).logging).toEqual({
      level: expectedLevel,
    });
    expect(readFileSync(fixture.configPath, "utf8")).toContain(
      `level = "${expectedLevel}"`,
    );
    expect(output.join("")).toContain(enabled ? "已开启" : "已关闭");
    expect(output.join("")).toContain(
      enabled ? "需要重建 Gateway 连接" : "当前值未变化，配置文件未写入，无需重启服务",
    );
  });

  it("returns without changing config when going back", async () => {
    const fixture = createFixture();
    const before = readFileSync(fixture.configPath, "utf8");

    await expect(runDebugSetup({
      environment: fixture.environment,
      output: { write: vi.fn() },
      prompts: {
        select: vi.fn(async () => "back"),
        isCancel: () => false,
      },
    })).resolves.toEqual({ action: "back" });

    expect(readFileSync(fixture.configPath, "utf8")).toBe(before);
  });
});

function createFixture(): {
  configPath: string;
  environment: NodeJS.ProcessEnv;
} {
  const root = mkdtempSync(join(tmpdir(), "codexc-debug-setup-"));
  roots.push(root);
  const home = join(root, ".codex-connect");
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  const environment = {
    ...process.env,
    CODEX_CONNECT_HOME: home,
    CODEX_CONNECT_CONFIG_FILE: "",
  };
  const initialized = initializeUserData({ environment, cwd: workspace });
  return { configPath: initialized.configPath, environment };
}
