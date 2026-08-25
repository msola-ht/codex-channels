import { describe, expect, it } from "vitest";

import { inspectManagedServiceStatus } from "../scripts/service-status.mjs";

describe("managed service JSON status", () => {
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
      platform: "win32",
      target: "gateway",
    })).toThrow("当前支持 macOS launchd 与 Linux systemd");
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
});
