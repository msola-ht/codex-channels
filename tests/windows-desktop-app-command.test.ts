import { spawn, type SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  inspectWindowsDesktopApp,
  openWindowsDesktopApp,
} from "../scripts/desktop-app-command.mjs";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Windows Desktop App command", () => {
  it("inspects only the verified executable and compatibility marker from a Windows package", () => {
    const root = mkdtempSync(join(tmpdir(), "codexc-desktop-windows-"));
    temporaryDirectories.push(root);
    const executablePath = join(root, "app", "ChatGPT.exe");
    const resourcePath = join(root, "app", "resources", "app.asar");
    mkdirSync(join(root, "app", "resources"), { recursive: true });
    writeFileSync(executablePath, "desktop");
    writeFileSync(resourcePath, "prefix CODEX_APP_SERVER_WS_URL suffix");

    expect(inspectWindowsDesktopApp({
      inspectInstallation: () => ({
        installed: true,
        executablePath,
        resourcePath,
        version: "26.910.1000.0",
        running: false,
      }),
    })).toEqual({
      installed: true,
      path: executablePath,
      version: "26.910.1000.0",
      running: false,
      compatible: true,
      reason: null,
    });
  });

  it("launches Desktop with a child-only endpoint and removes inherited aliases", async () => {
    const child = Object.assign(new EventEmitter(), {
      unrefCalls: 0,
      unref() { this.unrefCalls += 1; },
    });
    let launched: { file: string; args: readonly string[]; options: SpawnOptions } | undefined;
    const spawnProcess = ((file: string, args: readonly string[], options: SpawnOptions) => {
      launched = { file, args, options };
      queueMicrotask(() => child.emit("spawn"));
      return child;
    }) as unknown as typeof spawn;

    await openWindowsDesktopApp("/package/app/ChatGPT.exe", "ws://127.0.0.1/private?token=secret", {
      environment: {
        Path: "C:\\Windows\\System32",
        codex_app_server_ws_url: "ws://127.0.0.1/stale",
        KEEP_ME: "yes",
      },
      spawnProcess,
      startupConfirmationMs: 0,
    });

    expect(launched).toMatchObject({
      file: "/package/app/ChatGPT.exe",
      args: [],
      options: {
        cwd: "/package/app",
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      },
    });
    expect(launched?.options.env).toMatchObject({
      Path: "C:\\Windows\\System32",
      KEEP_ME: "yes",
      CODEX_APP_SERVER_WS_URL: "ws://127.0.0.1/private?token=secret",
    });
    expect(launched?.options.env).not.toHaveProperty("codex_app_server_ws_url");
    expect(child.unrefCalls).toBe(1);
  });
});
