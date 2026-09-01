import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import type { TomlTable } from "smol-toml";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  readGatewayConfig,
  writeGatewayConfig,
} from "../runtime/gateway-config.mjs";
import {
  ServiceInstallManagementError,
  prepareServiceInstall,
  previewServiceInstall,
  writeServiceDefinitions,
} from "../scripts/service-install-management.mjs";
import { initializeUserData } from "../scripts/runtime-config.mjs";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("service install management", () => {
  it("returns a redacted Linux plan with core and optional services", () => {
    const fixture = createFixture();
    const document = readGatewayConfig(fixture.configPath);
    document.telegram = {
      bot_token: "must-not-leak",
      allowed_user_ids: [123],
      message_format: "html",
    };
    writeGatewayConfig(fixture.configPath, document);

    const preview = previewServiceInstall(fixture.environment, {
      operatingSystem: "linux",
    });

    expect(preview).toMatchObject({
      operation: "install",
      operatingSystem: "linux",
      serviceManager: "systemd",
      configPath: fixture.configPath,
      activation: "none",
      steps: [
        "validate-config",
        "preflight",
        "write-definitions",
        "activate-core",
        "verify-core",
      ],
    });
    expect(preview.revision).toMatch(/^[0-9a-f]{64}$/u);
    expect(preview.services.map((service) => [
      service.target,
      service.startsOnInstall,
    ])).toEqual([
      ["app-server", true],
      ["gateway", true],
      ["webui", false],
      ["center", false],
    ]);
    expect(preview.services[0]?.destination).toBe(join(
      fixture.root,
      ".config/systemd/user/codex-connect-app-server.service",
    ));
    expect(JSON.stringify(preview)).not.toContain("must-not-leak");
  });

  it("executes every stage and emits structured progress", async () => {
    const fixture = createFixture();
    const validateConfig = vi.fn();
    const preflight = vi.fn();
    const activateCore = vi.fn();
    const waitForCore = vi.fn();
    const writeDefinition = vi.fn();
    const progress: Array<{ stage: string; status: string }> = [];
    const prepared = prepareServiceInstall(fixture.environment, {
      operatingSystem: "linux",
      validateConfig,
      preflight,
      activateCore,
      waitForCore,
      writeDefinition,
      onProgress: ({ stage, status }) => {
        progress.push({ stage, status });
        if (stage === "validate-config" && status === "started") {
          throw new Error("observer unavailable");
        }
      },
    });

    const result = await prepared.execute();

    expect(result.action).toBe("installed");
    expect(result.completedStages).toEqual(result.steps);
    expect(validateConfig).toHaveBeenCalledWith(fixture.environment);
    expect(preflight).toHaveBeenCalledOnce();
    expect(activateCore).toHaveBeenCalledOnce();
    expect(waitForCore).toHaveBeenCalledWith(
      "all",
      fixture.environment,
      undefined,
    );
    expect(writeDefinition).toHaveBeenCalledTimes(4);
    for (const [, content] of writeDefinition.mock.calls) {
      expect(content).not.toMatch(/__[A-Z_]+__/u);
    }
    expect(progress).toEqual(result.steps.flatMap((stage) => [
      { stage, status: "started" },
      { stage, status: "completed" },
    ]));
  });

  it("rejects a stale prepared plan before executing stages", async () => {
    const fixture = createFixture();
    const validateConfig = vi.fn();
    const prepared = prepareServiceInstall(fixture.environment, {
      operatingSystem: "linux",
      validateConfig,
    });
    const document = readGatewayConfig(fixture.configPath);
    document.codex = {
      ...table(document.codex),
      socket_path: "runtime/changed.sock",
    };
    writeGatewayConfig(fixture.configPath, document);

    await expect(prepared.execute()).rejects.toSatisfy((error: unknown) =>
      error instanceof ServiceInstallManagementError
      && error.code === "stale-plan"
      && error.completedStages.length === 0
      && error.recovery === "recreate-plan");
    expect(validateConfig).not.toHaveBeenCalled();
  });

  it("reports the failed stage and completed work without parsing shell output", async () => {
    const fixture = createFixture();
    let writes = 0;
    const prepared = prepareServiceInstall(fixture.environment, {
      operatingSystem: "linux",
      validateConfig: () => undefined,
      preflight: () => undefined,
      writeDefinition: () => {
        writes += 1;
        if (writes === 2) throw new Error("disk unavailable");
      },
    });

    await expect(prepared.execute()).rejects.toSatisfy((error: unknown) =>
      error instanceof ServiceInstallManagementError
      && error.code === "install-stage-failed"
      && error.stage === "write-definitions"
      && error.completedStages.join(",") === "validate-config,preflight"
      && error.recovery === "retry-install");
  });

  it("restores the service runtime after activation fails", async () => {
    const fixture = createFixture();
    const rollbackCore = vi.fn();
    const prepared = prepareServiceInstall(fixture.environment, {
      operatingSystem: "linux",
      validateConfig: () => undefined,
      preflight: () => undefined,
      writeDefinition: () => undefined,
      activateCore: () => {
        throw new Error("activation failed");
      },
      rollbackCore,
    });

    await expect(prepared.execute()).rejects.toSatisfy((error: unknown) =>
      error instanceof ServiceInstallManagementError
      && error.code === "install-stage-failed"
      && error.stage === "activate-core");
    expect(rollbackCore).toHaveBeenCalledOnce();
  });

  it("uses the same contract for launchd and Windows Scheduled Tasks", () => {
    const fixture = createFixture();
    const written: Array<{ path: string; content: string }> = [];
    const launchd = previewServiceInstall(fixture.environment, {
      operatingSystem: "darwin",
    });
    writeServiceDefinitions(fixture.environment, {
      operatingSystem: "darwin",
      writeDefinition: (path, content) => written.push({ path, content }),
    });

    expect(launchd).toMatchObject({
      operatingSystem: "darwin",
      serviceManager: "launchd",
    });
    expect(launchd.services[0]?.destination).toBe(join(
      fixture.root,
      "Library/LaunchAgents/com.hegenai.codex-app-server.plist",
    ));
    expect(written).toHaveLength(4);
    for (const file of written) {
      expect(file.path).toMatch(/\.plist$/u);
      expect(file.content).not.toMatch(/__[A-Z_]+__/u);
    }
    const windowsWritten: Array<{ path: string; content: string }> = [];
    const pwshExecutable = join(fixture.root, "PowerShell", "pwsh.exe");
    const windows = previewServiceInstall(fixture.environment, {
      operatingSystem: "win32",
      pwshExecutable,
    });
    writeServiceDefinitions(fixture.environment, {
      operatingSystem: "win32",
      pwshExecutable,
      writeDefinition: (path, content) => windowsWritten.push({ path, content }),
    });
    expect(windows).toMatchObject({
      operatingSystem: "win32",
      serviceManager: "windows",
    });
    expect(windows.services[0]?.destination).toBe(join(
      fixture.root,
      ".codex-connect/services/app-server.json",
    ));
    expect(windowsWritten).toHaveLength(8);
    const definitions = windowsWritten.filter((file) => file.path.endsWith(".json"));
    const launchers = windowsWritten.filter((file) => file.path.endsWith(".vbs"));
    expect(definitions).toHaveLength(4);
    expect(launchers).toHaveLength(4);
    for (const file of definitions) {
      expect(file.content).not.toContain("must-not-leak");
      expect(JSON.parse(file.content)).toMatchObject({
        version: 1,
        pwshBinary: pwshExecutable,
        vbsLauncherPath: expect.stringMatching(/\.vbs$/u),
      });
      expect(JSON.parse(file.content).environment.PATH).toContain(dirname(pwshExecutable));
    }
    for (const file of launchers) {
      expect(file.content).toContain("CreateObject(\"WScript.Shell\")");
      expect(file.content).toContain("shell.Run");
      expect(file.content).toContain(", 0, True)");
    }
  });
});

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "codex-connect-service-management-"));
  temporaryDirectories.push(root);
  const home = join(root, ".codex-connect");
  const workspace = join(root, "Workspace");
  mkdirSync(workspace);
  const environment = {
    ...process.env,
    HOME: root,
    USERPROFILE: root,
    XDG_CONFIG_HOME: join(root, ".config"),
    CODEX_CONNECT_HOME: home,
    CODEX_CONNECT_CONFIG_FILE: "",
    PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}`,
  };
  initializeUserData({ environment, cwd: workspace });
  const configPath = join(home, "config.toml");
  const document = readGatewayConfig(configPath);
  document.codex = {
    ...table(document.codex),
    binary: process.execPath,
    socket_path: "runtime/codex-app-server.sock",
  };
  writeGatewayConfig(configPath, document);
  expect(readFileSync(configPath, "utf8")).not.toBe("");
  return { root, environment, configPath };
}

function table(value: unknown): TomlTable {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as TomlTable
    : {};
}
