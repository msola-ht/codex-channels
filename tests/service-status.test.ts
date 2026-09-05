import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import {
  inspectManagedServiceStatus,
  inspectManagedServiceStatusAsync,
  readManagedServiceError,
  readManagedServiceErrorAsync,
} from "../scripts/service-status.mjs";

describe("managed service JSON status", () => {
  it("supports asynchronous supervisor queries for WebUI callers", async () => {
    const calls: string[][] = [];
    const status = await inspectManagedServiceStatusAsync({
      environment: {},
      platform: "linux",
      run: async (_executable, args) => {
        calls.push([...args]);
        return {
          status: 0,
          stdout: "LoadState=loaded\nActiveState=active\nSubState=running\nMainPID=789\n",
          stderr: "",
        };
      },
      target: "webui",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("codex-connect-webui.service");
    expect(status).toMatchObject({
      platform: "systemd",
      target: "webui",
      healthy: true,
      services: [{ target: "webui", running: true, pid: 789 }],
    });
  });

  it("normalizes systemd service properties and reports unhealthy targets", () => {
    const run = (_executable: string, args: readonly string[]) => {
      const gateway = args.includes("codex-connect-gateway.service");
      return {
        status: 0,
        stdout: gateway
          ? "LoadState=loaded\nActiveState=inactive\nSubState=dead\nMainPID=0\n"
          : "LoadState=loaded\nActiveState=active\nSubState=running\nMainPID=123\n",
        stderr: "",
      };
    };

    expect(inspectManagedServiceStatus({
      environment: {},
      platform: "linux",
      run,
      target: "all",
    })).toEqual({
      platform: "systemd",
      target: "all",
      healthy: false,
      services: [
        {
          target: "app-server",
          name: "Codex App Server",
          identifier: "codex-connect-app-server.service",
          loaded: true,
          running: true,
          state: "active/running",
          pid: 123,
        },
        {
          target: "gateway",
          name: "Gateway",
          identifier: "codex-connect-gateway.service",
          loaded: true,
          running: false,
          state: "inactive/dead",
          pid: null,
        },
      ],
    });
  });

  it("normalizes running and missing launchd jobs", () => {
    const run = (_executable: string, args: readonly string[]) => {
      if (args[1]?.endsWith("com.hegenai.codex-app-server")) {
        return {
          status: 0,
          stdout: "gui/501/com.hegenai.codex-app-server = {\n\tstate = running\n\tpid = 321\n}\n",
          stderr: "",
        };
      }
      return { status: 113, stdout: "", stderr: "Could not find service" };
    };

    expect(inspectManagedServiceStatus({
      environment: {},
      platform: "darwin",
      run,
      target: "all",
      userId: 501,
    })).toEqual({
      platform: "launchd",
      target: "all",
      healthy: false,
      services: [
        {
          target: "app-server",
          name: "Codex App Server",
          identifier: "com.hegenai.codex-app-server",
          loaded: true,
          running: true,
          state: "running",
          pid: 321,
        },
        {
          target: "gateway",
          name: "Gateway",
          identifier: "com.hegenai.codex-gateway",
          loaded: false,
          running: false,
          state: "missing",
          pid: null,
        },
      ],
    });
  });

  it("fails closed for launchd query errors and unsupported platforms", () => {
    const run = () => ({ status: 1, stdout: "", stderr: "permission denied\nsecret detail" });

    expect(() => inspectManagedServiceStatus({
      environment: {},
      platform: "darwin",
      run,
      target: "gateway",
      userId: 501,
    })).toThrow("permission denied");
    expect(() => inspectManagedServiceStatus({
      platform: "aix",
      target: "gateway",
    })).toThrow("当前支持 macOS launchd、Linux systemd 与 Windows 计划任务");
  });

  it("returns the normalized Windows Scheduled Task status", () => {
    const status = {
      platform: "windows",
      target: "gateway",
      healthy: true,
      services: [{
        target: "gateway",
        name: "Gateway",
        identifier: "Codex Connect Gateway",
        loaded: true,
        running: true,
        state: "running",
        pid: 456,
      }],
    };
    expect(inspectManagedServiceStatus({
      environment: { CODEX_CONNECT_HOME: "C:\\Users\\test\\.codex-connect" },
      platform: "win32",
      run: () => ({
        status: 0,
        stdout: `${JSON.stringify(status)}\n`,
        stderr: "",
      }),
      target: "gateway",
    })).toEqual(status);
  });

  it("accepts only explicit systemd not-found output after a failed query", () => {
    expect(inspectManagedServiceStatus({
      environment: {},
      platform: "linux",
      run: () => ({
        status: 4,
        stdout: "LoadState=not-found\nActiveState=inactive\nSubState=dead\nMainPID=0\n",
        stderr: "Unit was not found",
      }),
      target: "gateway",
    })).toMatchObject({
      healthy: false,
      services: [{ loaded: false, running: false, state: "not-found", pid: null }],
    });

    expect(() => inspectManagedServiceStatus({
      environment: {},
      platform: "linux",
      run: () => ({
        status: 1,
        stdout: "LoadState=loaded\n",
        stderr: "permission denied\ninternal detail",
      }),
      target: "gateway",
    })).toThrow("permission denied");
  });

  it("returns a bounded and redacted recent managed-service error", () => {
    const home = mkdtempSync(join(tmpdir(), "codexc-service-error-"));
    try {
      mkdirSync(join(home, "runtime"));
      writeFileSync(
        join(home, "runtime", "gateway.error.log"),
        "Error: authorization: Bearer very-secret\nToken=another-secret\n\"access_token\":\"json-secret\"\n",
      );
      const error = readManagedServiceError({
        environment: { CODEX_CONNECT_HOME: home },
        target: "gateway",
        now: Date.now() + 1_000,
      });
      expect(error).toMatchObject({ message: "Error: authorization: Bearer [已隐藏]；Token=[已隐藏]；\"access_token\":\"[已隐藏]\"" });
      expect(error?.message).not.toContain("very-secret");
      expect(error?.message).not.toContain("another-secret");
      expect(error?.message).not.toContain("json-secret");
      expect(error?.observedAt).toMatch(/Z$/u);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("reads Linux journald errors through the fixed service unit", async () => {
    const calls: string[][] = [];
    const error = await readManagedServiceErrorAsync({
      environment: {},
      platform: "linux",
      target: "gateway",
      run: async (_executable, args) => {
        calls.push([...args]);
        return {
          status: 0,
          stdout: "2026-09-04T00:00:00Z host gateway[123]: Error access_token=journal-secret\n",
          stderr: "",
        };
      },
    });
    expect(calls).toEqual([[
      "--user-unit=codex-connect-gateway.service",
      "--priority=err",
      "--lines=3",
      "--no-pager",
      "--output=short-iso",
    ]]);
    expect(error).toEqual({ message: "2026-09-04T00:00:00Z host gateway[123]: Error access_token=[已隐藏]", observedAt: null });
  });

  it("treats an empty Linux journald result as no recent error", async () => {
    const error = await readManagedServiceErrorAsync({
      environment: {},
      platform: "linux",
      target: "gateway",
      run: async () => ({ status: 0, stdout: "-- No entries --\n", stderr: "" }),
    });
    expect(error).toBeNull();
  });

  it("drops a truncated first log line before sanitizing the bounded tail", () => {
    const home = mkdtempSync(join(tmpdir(), "codexc-service-error-tail-"));
    try {
      mkdirSync(join(home, "runtime"));
      writeFileSync(
        join(home, "runtime", "gateway.error.log"),
        `Token=${"secret".repeat(4_000)}\nvisible-error\n`,
      );
      const error = readManagedServiceError({
        environment: { CODEX_CONNECT_HOME: home },
        target: "gateway",
      });
      expect(error?.message).toBe("visible-error");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
