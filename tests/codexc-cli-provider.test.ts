import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { writeCodexProxySettings } from "../runtime/codex-proxy-env.mjs";

import { afterEach, describe, expect, it } from "vitest";

import { inspectAppServerSupervisor } from "../runtime/app-server-supervisor.mjs";
import { cli, mkdtempSync, table, unixSocketTmpdir, updateGatewayConfig, waitForCondition } from "./codexc-cli-test-fixture.js";

const temporaryDirectories: string[] = [];

function signalTestProcess(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) {
      throw error;
    }
  }
}
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("codexc CLI", { timeout: 15_000 }, () => {
  if (process.platform === "win32") {
    it.skip("Windows 使用独立服务合同测试覆盖 Provider；Unix 套接字集成夹具不适用", () => undefined);
    return;
  }
  it("starts the App Server with effective proxy settings and the official path allowlist", () => {
    const root = mkdtempSync(join(unixSocketTmpdir, "codex-connect-service-entry-"));
    temporaryDirectories.push(root);
    const home = join(root, ".codex-connect");
    const codexHome = join(root, ".codex");
    const workspace = join(root, "Workspace");
    const capturePath = join(root, "capture.json");
    const fakeCodex = join(root, "fake-codex.mjs");
    mkdirSync(workspace);
    mkdirSync(codexHome);
    writeFileSync(fakeCodex, [
      "#!/usr/bin/env node",
      "import { writeFileSync } from 'node:fs';",
      "const args = process.argv.slice(2);",
      "const baseUrlArgument = args.find((value) => value.startsWith('openai_base_url='));",
      "const openAiApiPathStatus = baseUrlArgument === undefined ? null : (await fetch(`${JSON.parse(baseUrlArgument.slice('openai_base_url='.length))}/alpha/search`, { method: 'POST' })).status;",
      "writeFileSync(process.env.CODEX_TEST_CAPTURE, JSON.stringify({",
      "  args,",
      "  openAiApiPathStatus,",
      "  cwd: process.cwd(),",
      "  httpsProxy: process.env.HTTPS_PROXY,",
      "  lowerHttpsProxy: process.env.https_proxy,",
      "  serviceRole: process.env.CODEX_CONNECT_SERVICE_ROLE,",
      "}));",
    ].join("\n"));
    chmodSync(fakeCodex, 0o700);
    writeFileSync(
      join(codexHome, "config.toml"),
      'openai_base_url = "http://127.0.0.1:1/v1"\n',
      { mode: 0o600 },
    );
    const environment = {
      ...process.env,
      CODEX_CONNECT_HOME: home,
      CODEX_CONNECT_CONFIG_FILE: "",
      CODEX_HOME: codexHome,
      CODEX_TEST_CAPTURE: capturePath,
    };
    execFileSync(process.execPath, [cli, "init"], { cwd: workspace, env: environment });
    const configPath = join(home, "config.toml");
    updateGatewayConfig(configPath, (document) => {
      table(document.codex).binary = fakeCodex;
      writeCodexProxySettings({ https_proxy: "http://127.0.0.1:8899" }, environment);
    });

    execFileSync(process.execPath, [cli, "service-app-server"], {
      cwd: root,
      env: environment,
    });

    const captured = JSON.parse(readFileSync(capturePath, "utf8")) as {
      args: string[];
      openAiApiPathStatus: number;
      cwd: string;
      httpsProxy: string;
      lowerHttpsProxy: string;
      serviceRole: string;
    };
    expect(captured.args).toEqual([
      "-c",
      expect.stringMatching(/^openai_base_url="http:\/\/127\.0\.0\.1:\d+"$/u),
      "app-server",
      "--listen",
      `unix://${join(home, "runtime", "codex-app-server.sock")}`,
    ]);
    expect(captured).toMatchObject({
      openAiApiPathStatus: 502,
      cwd: realpathSync(join(home, "workspace")),
      httpsProxy: "http://127.0.0.1:8899",
      lowerHttpsProxy: "http://127.0.0.1:8899",
      serviceRole: "app-server",
    });
  });

  it("finishes service shutdown when an App Server ignores graceful termination", async () => {
    const root = mkdtempSync(join(unixSocketTmpdir, "codex-connect-service-shutdown-"));
    temporaryDirectories.push(root);
    const home = join(root, ".codex-connect");
    const codexHome = join(root, ".codex");
    const workspace = join(root, "Workspace");
    const capturePath = join(root, "capture.json");
    const fakeCodex = join(root, "fake-codex.mjs");
    mkdirSync(workspace);
    mkdirSync(codexHome);
    writeFileSync(fakeCodex, [
      "#!/usr/bin/env node",
      "import { writeFileSync } from 'node:fs';",
      "let signals = 0;",
      "const capture = () => writeFileSync(process.env.CODEX_TEST_CAPTURE, JSON.stringify({ pid: process.pid, signals }));",
      "process.on('SIGTERM', () => { signals += 1; capture(); });",
      "capture();",
      "setInterval(() => undefined, 1000);",
    ].join("\n"));
    chmodSync(fakeCodex, 0o700);
    const environment = {
      ...process.env,
      CODEX_CONNECT_HOME: home,
      CODEX_CONNECT_CONFIG_FILE: "",
      CODEX_HOME: codexHome,
      CODEX_TEST_CAPTURE: capturePath,
    };
    execFileSync(process.execPath, [cli, "init"], { cwd: workspace, env: environment });
    updateGatewayConfig(join(home, "config.toml"), (document) => {
      table(document.codex).binary = fakeCodex;
    });
    const service = spawn(process.execPath, [cli, "service-app-server"], {
      cwd: root,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const exited = new Promise<void>((resolveExit) => service.once("exit", () => resolveExit()));

    let exitedWithinLimit = false;
    let captured: { pid?: number; signals?: number };
    try {
      await waitForCondition(() => existsSync(capturePath), 2_000);
      await expect(inspectAppServerSupervisor(
        join(home, "runtime", "codex-app-server.sock"),
      )).resolves.toBeDefined();
      service.kill("SIGTERM");
      exitedWithinLimit = await Promise.race([
        exited.then(() => true),
        new Promise<false>((resolveTimeout) => setTimeout(() => resolveTimeout(false), 8_000)),
      ]);
    } finally {
      captured = existsSync(capturePath)
        ? JSON.parse(readFileSync(capturePath, "utf8")) as { pid?: number }
        : {};
      if (!exitedWithinLimit) {
        if (service.exitCode === null && service.signalCode === null) service.kill("SIGKILL");
        if (typeof captured.pid === "number") {
          signalTestProcess(captured.pid, "SIGKILL");
        }
        await exited;
      }
    }
    expect(exitedWithinLimit).toBe(true);
    expect(captured.signals).toBeGreaterThanOrEqual(1);
  });


});
