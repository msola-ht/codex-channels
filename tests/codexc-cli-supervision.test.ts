import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";

import { GatewayOwner, gatewayOwnerIsActive } from "../runtime/gateway-owner.mjs";
import {
  deepseekAccountDefinition,
  opencodeGoProviderDefinition
} from "../runtime/model-provider-definitions.mjs";
import {
  cli,
  execFileAsync,
  mkdtempSync,
  table,
  unixSocketTmpdir,
  updateGatewayConfig,
  waitForCondition,
  writeManagedProviderFixture,
} from "./codexc-cli-test-fixture.js";

const temporaryDirectories: string[] = [];

function readCapturedInitialization(path: string): boolean {
  if (!existsSync(path)) return false;
  try {
    return JSON.parse(readFileSync(path, "utf8")).initialized === true;
  } catch {
    return false;
  }
}

function signalTestProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
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
    it.skip("Windows 进程监督由计划任务与服务合同测试覆盖；Unix 进程夹具不适用", () => undefined);
    return;
  }
  it("does not start an on-demand Provider proxy before that Provider is used", async () => {
    const root = mkdtempSync(join(unixSocketTmpdir, "codex-connect-service-proxy-"));
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
      "import { get } from 'node:http';",
      "const baseUrlArg = process.argv.slice(2).find((value) => value.startsWith('model_providers.ocg-main.base_url='));",
      "if (!baseUrlArg) { await new Promise((resolve) => setTimeout(resolve, 500)); process.exit(0); }",
      "const baseUrl = JSON.parse(baseUrlArg.slice(baseUrlArg.indexOf('=') + 1));",
      "const status = await new Promise((resolve) => {",
      "  const request = get(new URL('/health', baseUrl), (response) => { response.resume(); response.on('end', () => resolve(response.statusCode)); });",
      "  request.on('error', () => resolve(0));",
      "});",
      "writeFileSync(process.env.CODEX_TEST_CAPTURE, JSON.stringify({ baseUrl, status }));",
    ].join("\n"));
    chmodSync(fakeCodex, 0o700);
    writeManagedProviderFixture(
      codexHome,
      home,
      opencodeGoProviderDefinition,
      "switching",
      "sk-service-secret",
    );
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

    execFileSync(process.execPath, [cli, "service-app-server"], {
      cwd: root,
      env: environment,
    });

    expect(existsSync(capturePath)).toBe(false);
  });

  it("starts an exclusive DeepSeek Gateway and reclaims ownership after forced shutdown", async () => {
    const root = mkdtempSync(join(unixSocketTmpdir, "codex-connect-start-exclusive-"));
    temporaryDirectories.push(root);
    const home = join(root, ".codex-connect");
    const codexHome = join(root, ".codex");
    const workspace = join(root, "Workspace");
    const capturePath = join(root, "capture.json");
    const fakeCodex = join(root, "fake-codex.mjs");
    const expectedAppServerVersion = (
      JSON.parse(
        readFileSync(resolve("src/codex-protocol/version.json"), "utf8"),
      ) as { codexCli: string }
    ).codexCli.replace(/^codex-cli /u, "");
    mkdirSync(workspace);
    mkdirSync(codexHome);
    writeFileSync(fakeCodex, [
      "#!/usr/bin/env node",
      "import { createServer } from 'node:http';",
      "import { writeFileSync } from 'node:fs';",
      `const { WebSocketServer } = await import(${JSON.stringify(pathToFileURL(resolve("node_modules/ws/wrapper.mjs")).href)});`,
      "const args = process.argv.slice(2);",
      `if (args[0] === '--version') { process.stdout.write('codex-cli ${expectedAppServerVersion}\\n'); process.exit(0); }`,
      "const baseUrlArg = args.find((value) => value.startsWith('model_providers.ds-test.base_url='));",
      "const listenUrl = args.at(-1);",
      "const socketPath = listenUrl?.startsWith('unix://') ? listenUrl.slice('unix://'.length) : undefined;",
      "const capture = {",
      "  baseUrlArg,",
      "  requestRetries: args.find((value) => value === 'model_providers.ds-test.request_max_retries=1'),",
      "  streamRetries: args.find((value) => value === 'model_providers.ds-test.stream_max_retries=0'),",
      "  initialized: false,",
      "};",
      "writeFileSync(process.env.CODEX_TEST_CAPTURE, JSON.stringify(capture));",
      "if (!socketPath) process.exit(2);",
      "const server = createServer();",
      "const webSocketServer = new WebSocketServer({ server });",
      "webSocketServer.on('connection', (client) => client.on('message', (data) => {",
      "  const message = JSON.parse(data.toString());",
      "  if (message.method === 'initialize') {",
      "    capture.initialized = true;",
      "    writeFileSync(process.env.CODEX_TEST_CAPTURE, JSON.stringify(capture));",
      "    client.send(JSON.stringify({",
      "    jsonrpc: '2.0', id: message.id, result: {",
      `      userAgent: 'codex_cli_rs/${expectedAppServerVersion} (test; test)',`,
      "      codexHome: process.env.CODEX_HOME, platformFamily: 'unix', platformOs: 'linux',",
      "    },",
      "    }));",
      "  }",
      "}));",
      "server.listen(socketPath);",
      "const stop = () => {",
      "  if (process.env.CODEX_TEST_IGNORE_SIGTERM === '1') return;",
      "  for (const client of webSocketServer.clients) client.terminate();",
      "  webSocketServer.close(() => server.close(() => process.exit(0)));",
      "};",
      "process.once('SIGTERM', stop);",
      "process.once('SIGINT', stop);",
    ].join("\n"));
    chmodSync(fakeCodex, 0o700);
    writeManagedProviderFixture(
      codexHome,
      home,
      deepseekAccountDefinition("test"),
      "exclusive",
      "sk-start-secret",
    );
    const environment = {
      ...process.env,
      CODEX_CONNECT_HOME: home,
      CODEX_CONNECT_CONFIG_FILE: "",
      CODEX_HOME: codexHome,
      CODEX_TEST_CAPTURE: capturePath,
      CODEX_TEST_IGNORE_SIGTERM: "1",
    };
    execFileSync(process.execPath, [cli, "init"], { cwd: workspace, env: environment });
    updateGatewayConfig(join(home, "config.toml"), (document) => {
      table(document.codex).binary = fakeCodex;
      table(document.telegram).bot_token = "123456:test-token";
      table(document.telegram).allowed_user_ids = [123456];
    });

    const child = spawn(process.execPath, [cli, "start"], {
      cwd: root,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolveExit) => child.once("exit", (code, signal) => resolveExit({ code, signal })),
    );

    let publicCommandExitedWithinLimit: boolean;
    try {
      await waitForCondition(
        () => existsSync(join(home, "runtime", "gateway-owner.sock"))
          && readCapturedInitialization(capturePath)
          && stdout.includes("Codex App Server 已连接"),
        10_000,
        () => child.exitCode === null
          ? undefined
          : new Error(
            `前台 Gateway 提前退出：\nstdout:\n${stdout}\nstderr:\n${stderr}`
            + `\ncapture:\n${existsSync(capturePath) ? readFileSync(capturePath, "utf8") : "missing"}`,
          ),
      );
      expect(stdout).toContain("Codex App Server 与模型统计代理已启动");
      expect(stdout).toContain("Codex App Server 已连接");
      expect(stderr).not.toContain("WebSocket 就绪前退出");
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      publicCommandExitedWithinLimit = await Promise.race([
        exited.then(() => true),
        new Promise<false>((resolveTimeout) => {
          setTimeout(() => resolveTimeout(false), 7_000);
        }),
      ]);
      if (!publicCommandExitedWithinLimit) {
        if (process.platform !== "win32" && child.pid !== undefined) {
          signalTestProcessGroup(child.pid, "SIGKILL");
        } else if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
        }
        await exited;
      }
    }
    expect(publicCommandExitedWithinLimit).toBe(true);
    const reclaimedOwner = new GatewayOwner(join(home, "config.toml"));
    try {
      await reclaimedOwner.start();
      expect(statSync(join(home, "runtime", "gateway-owner.sock")).mode & 0o777).toBe(0o600);
    } finally {
      await reclaimedOwner.close();
    }
    expect(existsSync(join(home, "runtime", "gateway-owner.sock"))).toBe(false);
    const captured = JSON.parse(readFileSync(capturePath, "utf8")) as {
      baseUrlArg?: string;
      requestRetries?: string;
      streamRetries?: string;
      initialized?: boolean;
    };
    expect(captured.initialized).toBe(true);
    expect(captured.baseUrlArg).toMatch(
      /^model_providers\.ds-test\.base_url="http:\/\/127\.0\.0\.1:\d+\/go\/test"$/u,
    );
    expect(captured.requestRetries).toBe("model_providers.ds-test.request_max_retries=1");
    expect(captured.streamRetries).toBe("model_providers.ds-test.stream_max_retries=0");
  }, 15_000);

  it("rejects a partial App Server topology instead of bypassing a provider proxy", async () => {
    const root = mkdtempSync(join(unixSocketTmpdir, "codex-connect-start-partial-"));
    temporaryDirectories.push(root);
    const home = join(root, ".codex-connect");
    const codexHome = join(root, ".codex");
    const workspace = join(root, "Workspace");
    const fakeCodex = join(root, "fake-codex.mjs");
    mkdirSync(workspace);
    mkdirSync(codexHome);
    writeFileSync(fakeCodex, "#!/usr/bin/env node\nprocess.exit(0);\n");
    chmodSync(fakeCodex, 0o700);
    writeManagedProviderFixture(
      codexHome,
      home,
      deepseekAccountDefinition("test"),
      "switching",
      "sk-start-secret",
    );
    const environment = {
      ...process.env,
      CODEX_CONNECT_HOME: home,
      CODEX_CONNECT_CONFIG_FILE: "",
      CODEX_HOME: codexHome,
    };
    execFileSync(process.execPath, [cli, "init"], { cwd: workspace, env: environment });
    updateGatewayConfig(join(home, "config.toml"), (document) => {
      table(document.codex).binary = fakeCodex;
    });

    const socketPath = join(home, "runtime", "codex-app-server.sock");
    const server = createServer();
    const webSocketServer = new WebSocketServer({ server });
    await new Promise<void>((resolveListen, rejectListen) => {
      server.once("error", rejectListen);
      server.listen(socketPath, resolveListen);
    });

    try {
      const failure = await execFileAsync(
        process.execPath,
        [cli, "start"],
        { cwd: root, env: environment, encoding: "utf8" },
      ).then(
        () => undefined,
        (error: Error & { stderr?: string }) => error,
      );
      expect(failure?.stderr).toContain(
        "检测到部分 App Server 正在运行，无法安全补启动完整统计代理链路",
      );
    } finally {
      for (const client of webSocketServer.clients) {
        client.terminate();
      }
      await new Promise<void>((resolveClose) => webSocketServer.close(() => resolveClose()));
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }
  });

  it("rejects an unmanaged App Server even when its complete topology is healthy", async () => {
    const root = mkdtempSync(join(unixSocketTmpdir, "codex-connect-start-unmanaged-"));
    temporaryDirectories.push(root);
    const home = join(root, ".codex-connect");
    const codexHome = join(root, ".codex");
    const workspace = join(root, "Workspace");
    mkdirSync(workspace);
    mkdirSync(codexHome);
    writeManagedProviderFixture(
      codexHome,
      home,
      deepseekAccountDefinition("test"),
      "exclusive",
      "sk-start-secret",
    );
    const environment = {
      ...process.env,
      CODEX_CONNECT_HOME: home,
      CODEX_CONNECT_CONFIG_FILE: "",
      CODEX_HOME: codexHome,
    };
    execFileSync(process.execPath, [cli, "init"], { cwd: workspace, env: environment });

    const socketPath = join(home, "runtime", "codex-app-server.sock");
    const appServer = createServer();
    const webSocketServer = new WebSocketServer({ server: appServer });
    await new Promise<void>((resolveListen, rejectListen) => {
      appServer.once("error", rejectListen);
      appServer.listen(socketPath, resolveListen);
    });

    try {
      const failure = await execFileAsync(
        process.execPath,
        [cli, "start"],
        { cwd: root, env: environment, encoding: "utf8" },
      ).then(
        () => undefined,
        (error: Error & { stderr?: string }) => error,
      );
      expect(failure?.stderr).toContain(
        "现有 App Server 不属于 codexc 统一监管入口",
      );
    } finally {
      for (const client of webSocketServer.clients) {
        client.terminate();
      }
      await new Promise<void>((resolveClose) => webSocketServer.close(() => resolveClose()));
      await new Promise<void>((resolveClose) => appServer.close(() => resolveClose()));
    }
  });

  it("rejects an occupied App Server topology inside the shared supervisor entry", async () => {
    const root = mkdtempSync(join(unixSocketTmpdir, "codex-connect-service-occupied-"));
    temporaryDirectories.push(root);
    const home = join(root, ".codex-connect");
    const workspace = join(root, "Workspace");
    const fakeCodex = join(root, "fake-codex.mjs");
    mkdirSync(workspace);
    writeFileSync(fakeCodex, "#!/usr/bin/env node\nprocess.exit(0);\n");
    chmodSync(fakeCodex, 0o700);
    const environment = {
      ...process.env,
      CODEX_CONNECT_HOME: home,
      CODEX_CONNECT_CONFIG_FILE: "",
      CODEX_HOME: join(root, ".codex"),
    };
    execFileSync(process.execPath, [cli, "init"], { cwd: workspace, env: environment });
    updateGatewayConfig(join(home, "config.toml"), (document) => {
      table(document.codex).binary = fakeCodex;
    });

    const socketPath = join(home, "runtime", "codex-app-server.sock");
    const appServer = createServer();
    const webSocketServer = new WebSocketServer({ server: appServer });
    await new Promise<void>((resolveListen, rejectListen) => {
      appServer.once("error", rejectListen);
      appServer.listen(socketPath, resolveListen);
    });

    try {
      const failure = await execFileAsync(
        process.execPath,
        [cli, "service-app-server"],
        { cwd: root, env: environment, encoding: "utf8" },
      ).then(
        () => undefined,
        (error: Error & { stderr?: string }) => error,
      );
      expect(failure?.stderr).toContain(
        "App Server Socket 已被未受监管的进程占用",
      );
    } finally {
      for (const client of webSocketServer.clients) {
        client.terminate();
      }
      await new Promise<void>((resolveClose) => webSocketServer.close(() => resolveClose()));
      await new Promise<void>((resolveClose) => appServer.close(() => resolveClose()));
    }
  });

  it("rejects a second shared App Server supervisor", async () => {
    const root = mkdtempSync(join(unixSocketTmpdir, "codex-connect-service-owner-"));
    temporaryDirectories.push(root);
    const home = join(root, ".codex-connect");
    const workspace = join(root, "Workspace");
    const fakeCodex = join(root, "fake-codex.mjs");
    mkdirSync(workspace);
    writeFileSync(fakeCodex, "#!/usr/bin/env node\nprocess.exit(0);\n");
    chmodSync(fakeCodex, 0o700);
    const environment = {
      ...process.env,
      CODEX_CONNECT_HOME: home,
      CODEX_CONNECT_CONFIG_FILE: "",
      CODEX_HOME: join(root, ".codex"),
    };
    execFileSync(process.execPath, [cli, "init"], { cwd: workspace, env: environment });
    updateGatewayConfig(join(home, "config.toml"), (document) => {
      table(document.codex).binary = fakeCodex;
    });

    const ownerSocketPath = join(home, "runtime", "codex-app-server-supervisor.sock");
    const ownerServer = createNetServer((socket) => socket.end());
    await new Promise<void>((resolveListen, rejectListen) => {
      ownerServer.once("error", rejectListen);
      ownerServer.listen(ownerSocketPath, resolveListen);
    });

    try {
      const failure = await execFileAsync(
        process.execPath,
        [cli, "service-app-server"],
        { cwd: root, env: environment, encoding: "utf8" },
      ).then(
        () => undefined,
        (error: Error & { stderr?: string }) => error,
      );
      expect(failure?.stderr).toContain(
        "Codex App Server 统一监管入口已在运行",
      );
    } finally {
      await new Promise<void>((resolveClose) => ownerServer.close(() => resolveClose()));
    }
  });

  it("rejects a direct duplicate Gateway independently of Provider metrics sockets", async () => {
    const root = mkdtempSync(join(unixSocketTmpdir, "codex-connect-gateway-owner-entry-"));
    temporaryDirectories.push(root);
    const home = join(root, ".codex-connect");
    const workspace = join(root, "Workspace");
    mkdirSync(workspace);
    const environment = {
      ...process.env,
      CODEX_CONNECT_HOME: home,
      CODEX_CONNECT_CONFIG_FILE: "",
      CODEX_HOME: join(root, ".different-codex-home"),
    };
    execFileSync(process.execPath, [cli, "init"], { cwd: workspace, env: environment });
    updateGatewayConfig(join(home, "config.toml"), (document) => {
      table(document.telegram).bot_token = "123456:test-token";
      table(document.telegram).allowed_user_ids = [123456];
    });
    const owner = new GatewayOwner(join(home, "config.toml"));
    await owner.start();

    try {
      const duplicate = spawnSync(process.execPath, [cli, "gateway"], {
        cwd: root,
        env: environment,
        encoding: "utf8",
      });
      expect(duplicate.status).toBe(1);
      expect(duplicate.stderr).toContain("Gateway 已在运行，不能重复启动");
    } finally {
      await owner.close();
    }
  });

  it("does not start the Gateway before the App Server passes a WebSocket health check", async () => {
    const root = mkdtempSync(join(unixSocketTmpdir, "codex-connect-start-not-ready-"));
    temporaryDirectories.push(root);
    const home = join(root, ".codex-connect");
    const workspace = join(root, "Workspace");
    const fakeCodex = join(root, "fake-codex.mjs");
    mkdirSync(workspace);
    writeFileSync(fakeCodex, [
      "#!/usr/bin/env node",
      "import { createServer } from 'node:net';",
      "const listenUrl = process.argv.at(-1);",
      "const socketPath = listenUrl?.startsWith('unix://') ? listenUrl.slice('unix://'.length) : undefined;",
      "if (!socketPath) process.exit(2);",
      "const server = createServer();",
      "server.listen(socketPath, () => setTimeout(() => server.close(() => process.exit(0)), 500));",
    ].join("\n"));
    chmodSync(fakeCodex, 0o700);
    const environment = {
      ...process.env,
      CODEX_CONNECT_HOME: home,
      CODEX_CONNECT_CONFIG_FILE: "",
      CODEX_HOME: join(root, ".codex"),
    };
    execFileSync(process.execPath, [cli, "init"], { cwd: workspace, env: environment });
    updateGatewayConfig(join(home, "config.toml"), (document) => {
      table(document.codex).binary = fakeCodex;
    });

    const failure = await execFileAsync(
      process.execPath,
      [cli, "start"],
      { cwd: root, env: environment, encoding: "utf8", timeout: 10_000 },
    ).then(
      () => undefined,
      (error: Error & { stderr?: string }) => error,
    );
    expect(failure?.stderr).toContain(
      "App Server 在 WebSocket 就绪前退出",
    );
    expect(failure?.stderr).not.toContain("至少需要配置一个通讯渠道");
  });

  it("keeps the supervised Gateway waiting while the App Server is not ready", async () => {
    const root = mkdtempSync(join(unixSocketTmpdir, "codex-connect-gateway-wait-"));
    temporaryDirectories.push(root);
    const home = join(root, ".codex-connect");
    const workspace = join(root, "Workspace");
    mkdirSync(workspace);
    const environment = {
      ...process.env,
      CODEX_CONNECT_HOME: home,
      CODEX_CONNECT_CONFIG_FILE: "",
      CODEX_CONNECT_SERVICE_ROLE: "gateway",
    };
    execFileSync(process.execPath, [cli, "init"], { cwd: workspace, env: environment });
    updateGatewayConfig(join(home, "config.toml"), (document) => {
      table(document.telegram).bot_token = "123456:test-token";
      table(document.telegram).allowed_user_ids = [123456];
    });

    const gateway = spawn(process.execPath, [cli, "gateway"], {
      cwd: root,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const closed = new Promise<void>((resolveClose) => gateway.once("close", () => resolveClose()));

    try {
      await new Promise((resolveWait) => setTimeout(resolveWait, 1_500));
      expect(gateway.exitCode).toBeNull();
      await expect(gatewayOwnerIsActive(join(home, "config.toml"))).resolves.toBe(false);
    } finally {
      if (gateway.exitCode === null) gateway.kill("SIGTERM");
      await closed;
    }
  }, 10_000);


});
