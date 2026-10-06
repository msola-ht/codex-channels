import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";

import { resolveAppServerRuntime } from "../runtime/app-server-runtime.mjs";
import { AppServerSupervisorOwner } from "../runtime/app-server-supervisor.mjs";
import { startModelRelayService } from "../runtime/model-relay-service.mjs";
import { readGatewayConfig, writeGatewayConfig } from "../runtime/gateway-config.mjs";
import { GatewayOwner } from "../runtime/gateway-owner.mjs";
import { cli, execFileAsync, mkdtempSync } from "./codexc-cli-test-fixture.js";

const linuxIt = process.platform === "linux" ? it : it.skip;
const temporaryDirectories: string[] = [];

function writeServiceDefinitions(root: string, targets = ["gateway", "app-server", "webui", "model-relay"]): void {
  const directory = join(root, "config", "systemd", "user");
  mkdirSync(directory, { recursive: true });
  for (const target of targets) writeFileSync(join(directory, `codex-connect-${target}.service`), "fixture");
}

async function startWebuiReadinessFixture(configPath: string): Promise<ReturnType<typeof createServer>> {
  const server = createServer((request, response) => {
    response.writeHead(request.url === "/api/v1/health" ? 200 : 404);
    response.end("{}");
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected HTTP address");
  const document = readGatewayConfig(configPath);
  document.webui = { host: "127.0.0.1", port: address.port };
  writeGatewayConfig(configPath, document);
  return server;
}

async function startManagedServiceReadinessFixture(
  configPath: string,
  environment: NodeJS.ProcessEnv,
): Promise<{ close(): Promise<void> }> {
  const descriptor = resolveAppServerRuntime(
    readGatewayConfig(configPath),
    dirname(configPath),
    environment,
  );
  const servers: ReturnType<typeof createServer>[] = [];
  const webSocketServers: WebSocketServer[] = [];
  let supervisorOwner: AppServerSupervisorOwner | undefined;
  let gatewayOwner: GatewayOwner | undefined;

  const close = async (): Promise<void> => {
    if (gatewayOwner) await gatewayOwner.close();
    if (supervisorOwner) await supervisorOwner.close();
    for (const webSocketServer of webSocketServers) {
      for (const client of webSocketServer.clients) client.terminate();
      await new Promise<void>((resolveClose) => webSocketServer.close(() => resolveClose()));
    }
    for (const server of servers) {
      if (server.listening) {
        await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
      }
    }
  };

  try {
    for (const socketPath of descriptor.socketPaths) {
      const server = createServer();
      const webSocketServer = new WebSocketServer({ server });
      await new Promise<void>((resolveListen, rejectListen) => {
        server.once("error", rejectListen);
        server.listen(socketPath, resolveListen);
      });
      chmodSync(socketPath, 0o600);
      servers.push(server);
      webSocketServers.push(webSocketServer);
    }
    supervisorOwner = new AppServerSupervisorOwner(
      descriptor.primarySocketPath,
      descriptor.topology,
    );
    await supervisorOwner.start();
    gatewayOwner = new GatewayOwner(configPath);
    await gatewayOwner.start();
    gatewayOwner.markReady();
    return { close };
  } catch (error) {
    await close();
    throw error;
  }
}
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("codexc CLI", { timeout: 15_000 }, () => {
  it("documents restart and rejects arguments or self-interruption before service changes", () => {
    for (const flag of ["-h", "--help"]) {
      const help = execFileSync(process.execPath, [cli, "restart", flag], { encoding: "utf8" });
      expect(help).toContain("用法：codexc restart");
      expect(help).toContain("WebUI");
      expect(help).toContain("Relay");
    }
    const invalid = spawnSync(process.execPath, [cli, "restart", "all", "extra"], { encoding: "utf8" });
    expect(invalid.status).toBe(1);
    expect(invalid.stderr).toContain("用法：codexc restart");
    const guarded = spawnSync(process.execPath, [cli, "restart"], {
      encoding: "utf8", env: { ...process.env, CODEX_CONNECT_SERVICE_ROLE: "app-server" },
    });
    expect(guarded.status).toBe(1);
    expect(guarded.stderr).toContain("不能在 Codex App Server 内执行");
    for (const args of [["restart", "model-relay"], ["restart", "app-server"]]) {
      const rejected = spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });
      expect(rejected.status).toBe(1);
      expect(rejected.stderr).toContain("服务目标必须是");
    }
  });

  it("rejects the removed service namespace even for help", () => {
    for (const args of [[], ["-h"], ["--help"], ...["install", "uninstall", "start", "stop", "restart", "status", "logs", "reload"].map(action => [action])]) {
      const result = spawnSync(process.execPath, [cli, "service", ...args], { encoding: "utf8" });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("未知命令");
    }
  });

  linuxIt("restarts core services between WebUI stop and start and aborts on stop failures", async () => {
    const root = mkdtempSync(join(tmpdir(), "codexc-restart-"));
    temporaryDirectories.push(root);
    const manager = join(root, "systemctl");
    const log = join(root, "manager.log");
    writeFileSync(manager, '#!/bin/sh\nprintf "%s\\n" "$*" >> "$SERVICE_TEST_LOG"\nif [ "$2" = "show" ]; then printf "LoadState=loaded\\nActiveState=inactive\\nSubState=dead\\nMainPID=0\\n"; fi\nif [ "$2" = "stop" ] && [ "$3" = "$FAIL_STOP_UNIT" ]; then exit 1; fi\n');
    chmodSync(manager, 0o755);
    const configPath = join(root, "config.toml");
    const environment = { ...process.env, HOME: root, CODEX_HOME: join(root, "codex"), CODEX_CONNECT_HOME: root,
      CODEX_CONNECT_CONFIG_FILE: configPath, CODEX_CONNECT_SERVICE_ROLE: "", SYSTEMCTL_BINARY: manager,
      XDG_CONFIG_HOME: join(root, "config"), SERVICE_TEST_LOG: log };
    execFileSync(process.execPath, [cli, "init"], { env: environment, cwd: root });
    writeServiceDefinitions(root);
    const config = readGatewayConfig(configPath);
    config.telegram = { bot_token: "fixture", allowed_user_ids: [1] };
    writeGatewayConfig(configPath, config);
    const webui = await startWebuiReadinessFixture(configPath);
    const readiness = await startManagedServiceReadinessFixture(configPath, environment);
    const units = ["webui", "model-relay", "gateway", "app-server"];
    const stops = units.map(unit => `--user stop codex-connect-${unit}.service`);
    const operations = (): string[] => readFileSync(log, "utf8").trim().split("\n")
      .filter(line => /^--user (?:stop|start|restart) /u.test(line));
    try {
      const { stdout } = await execFileAsync(process.execPath, [cli, "restart"], { env: environment, cwd: root });
      expect(stdout).toContain("全部已选后台服务重启完成");
      expect(operations()).toEqual([...stops,
        "--user start codex-connect-app-server.service",
        "--user start codex-connect-gateway.service",
        "--user start codex-connect-webui.service",
      ]);
      for (const [index, unit] of units.entries()) {
        writeFileSync(log, "");
        await expect(execFileAsync(process.execPath, [cli, "restart"], {
          env: { ...environment, FAIL_STOP_UNIT: `codex-connect-${unit}.service` }, cwd: root,
        })).rejects.toThrow();
        expect(operations()).toEqual(stops.slice(0, index + 1));
      }
      writeFileSync(log, "");
      writeFileSync(configPath, "broken = [");
      await expect(execFileAsync(process.execPath, [cli, "restart"], { env: environment, cwd: root })).rejects.toThrow();
      expect(readFileSync(log, "utf8")).toBe("");
    } finally {
      await new Promise<void>((resolve, reject) => webui.close(error => error ? reject(error) : resolve()));
      await readiness.close();
    }
  });

  it("documents canonical service targets and rejects retired spelling for non-start actions", () => {
    for (const action of ["start", "stop", "status", "logs"]) {
      for (const flag of ["-h", "--help"]) {
        const help = execFileSync(process.execPath, [cli, action, flag], { encoding: "utf8" });
        expect(help).toContain(`用法：codexc ${action}`);
        expect(help).toContain("gateway|appserver|webui|relay|all");
        expect(help).not.toContain("model-relay");
      }
      if (action === "start") continue;
      for (const target of ["model-relay", "app-server"]) {
        const old = spawnSync(process.execPath, [cli, action, target], { encoding: "utf8" });
        expect(old.status).toBe(1);
        expect(old.stderr).toContain("服务目标必须是 gateway、appserver、webui、relay、all");
      }
    }
  });

  linuxIt("accepts only the canonical Relay start target through readiness checks", async () => {
    const root = mkdtempSync(join(tmpdir(), "codexc-relay-handoff-"));
    temporaryDirectories.push(root);
    const manager = join(root, "systemctl");
    const log = join(root, "manager.log");
    writeFileSync(manager, '#!/bin/sh\nprintf "%s\\n" "$*" >> "$SERVICE_TEST_LOG"\n');
    chmodSync(manager, 0o755);
    const configPath = join(root, "config.toml");
    const environment = { ...process.env, HOME: root, CODEX_HOME: join(root, "codex"), CODEX_CONNECT_HOME: root,
      CODEX_CONNECT_CONFIG_FILE: configPath, SYSTEMCTL_BINARY: manager,
      XDG_CONFIG_HOME: join(root, "config"), SERVICE_TEST_LOG: log };
    execFileSync(process.execPath, [cli, "init"], { env: environment, cwd: root });
    const config = readGatewayConfig(configPath);
    config.telegram = { bot_token: "fixture", allowed_user_ids: [1] };
    writeGatewayConfig(configPath, config);
    // Disabled isolated Relay provides a real private IPC readiness acknowledgment.
    const relay = await startModelRelayService(configPath, environment);
    try {
      await expect(execFileAsync(process.execPath, [cli, "start", "model-relay"], { env: environment, cwd: root })).rejects.toThrow();
      await execFileAsync(process.execPath, [cli, "start", "relay"], { env: environment, cwd: root });
      expect(readFileSync(log, "utf8").match(/start codex-connect-model-relay.service/gu)).toHaveLength(1);
    } finally { await relay.close(); }
    await expect(execFileAsync(process.execPath, [cli, "start", "relay"], { env: environment, cwd: root }))
      .rejects.toThrow("Model Relay 未就绪");
  });

  linuxIt.each([["relay", "model-relay"], ["appserver", "app-server"]])("maps public %s stop and status to the installed systemd unit", (target, internalTarget) => {
    const root = mkdtempSync(join(tmpdir(), "codexc-relay-name-"));
    temporaryDirectories.push(root);
    const manager = join(root, "systemctl");
    const log = join(root, "manager.log");
    writeFileSync(manager, '#!/bin/sh\nprintf "%s\\n" "$*" >> "$SERVICE_TEST_LOG"\n');
    chmodSync(manager, 0o755);
    const environment = { ...process.env, HOME: root, CODEX_CONNECT_HOME: root,
      CODEX_CONNECT_CONFIG_FILE: join(root, "missing.toml"), SYSTEMCTL_BINARY: manager,
      XDG_CONFIG_HOME: join(root, "config"), SERVICE_TEST_LOG: log, CODEX_CONNECT_SERVICE_ROLE: "" };
    for (const action of ["stop", "status"]) {
      execFileSync(process.execPath, [cli, action, target], { env: environment, encoding: "utf8" });
    }
    const calls = readFileSync(log, "utf8");
    expect(calls).toContain(`stop codex-connect-${internalTarget}.service`);
    expect(calls).toContain(`status codex-connect-${internalTarget}.service`);
    expect(calls).not.toContain(`codex-connect-${target}.service`);
  });

  it("rejects invalid service log options before reading user configuration", () => {
    const invalidLines = spawnSync(process.execPath, [cli, "logs", "--lines", "0"], {
      encoding: "utf8",
    });
    const unknown = spawnSync(process.execPath, [cli, "logs", "--unknown"], {
      encoding: "utf8",
    });
    const removedServiceOption = spawnSync(
      process.execPath,
      [cli, "logs", "--service", "all"],
      { encoding: "utf8" },
    );
    const invalidTarget = spawnSync(
      process.execPath,
      [cli, "restart", "unknown"],
      { encoding: "utf8" },
    );

    expect(invalidLines.status).toBe(1);
    expect(invalidLines.stderr).toContain("日志行数必须是 1 到 10000");
    expect(unknown.status).toBe(1);
    expect(unknown.stderr).toContain("未知日志参数");
    expect(removedServiceOption.status).toBe(1);
    expect(removedServiceOption.stderr).toContain("未知日志参数");
    expect(invalidTarget.status).toBe(1);
    expect(invalidTarget.stderr).toContain("服务目标必须是");
  });

  linuxIt("rejects service actions that would disconnect a command running inside App Server", async () => {
    const root = mkdtempSync(join(tmpdir(), "codex-connect-service-role-"));
    temporaryDirectories.push(root);
    const home = join(root, ".codex-connect");
    const workspace = join(root, "Workspace");
    const systemctlLog = join(root, "systemctl.log");
    const fakeSystemctl = join(root, "systemctl");
    const fakeLoginctl = join(root, "loginctl");
    mkdirSync(workspace);
    writeFileSync(
      fakeSystemctl,
      "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$SYSTEMCTL_LOG\"\nif [ \"$2\" = show ]; then printf 'LoadState=loaded\\n'; fi\n",
    );
    chmodSync(fakeSystemctl, 0o755);
    writeFileSync(
      fakeLoginctl,
      "#!/bin/sh\nif [ \"$1\" = \"show-user\" ]; then printf 'yes\\n'; fi\n",
    );
    chmodSync(fakeLoginctl, 0o755);
    const environment = {
      ...process.env,
      CODEX_CONNECT_HOME: home,
      CODEX_CONNECT_CONFIG_FILE: "",
      CODEX_CONNECT_SERVICE_ROLE: "app-server",
      XDG_CONFIG_HOME: join(root, "config"),
      SYSTEMCTL_BINARY: fakeSystemctl,
      LOGINCTL_BINARY: fakeLoginctl,
      SYSTEMCTL_LOG: systemctlLog,
    };
    execFileSync(process.execPath, [cli, "init"], { cwd: workspace, env: environment });

    for (const args of [
      ["restart", "appserver"],
      ["restart", "all"],
      ["stop", "gateway"],
      ["stop", "appserver"],
      ["stop", "all"],
      ["install"],
      ["uninstall", "--services"],
    ]) {
      const result = spawnSync(
        process.execPath,
        [cli, ...args],
        { cwd: workspace, env: environment, encoding: "utf8" },
      );
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("不能在 Codex App Server 内执行会中断当前渠道的服务操作");
    }
    expect(existsSync(systemctlLog) ? readFileSync(systemctlLog, "utf8") : "").toBe("");

    writeServiceDefinitions(root, ["gateway"]);
    const config = readGatewayConfig(join(home, "config.toml"));
    config.telegram = { bot_token: "fixture", allowed_user_ids: [1] };
    writeGatewayConfig(join(home, "config.toml"), config);

    const readiness = await startManagedServiceReadinessFixture(
      join(home, "config.toml"),
      environment,
    );
    try {
      const { stdout } = await execFileAsync(
        process.execPath,
        [cli, "restart", "gateway"],
        {
          cwd: workspace,
          env: {
            ...environment,
            // Retired test overrides must not bypass the production readiness protocol.
            CODEX_CONNECT_SERVICE_READINESS_BINARY: "/bin/false",
          },
          encoding: "utf8",
        },
      );
      expect(stdout).toContain("Gateway 已就绪；Codex App Server 保持运行");
      expect(readFileSync(systemctlLog, "utf8")).toContain(
        "--user start codex-connect-gateway.service",
      );
      expect(readFileSync(systemctlLog, "utf8")).not.toContain(
        "codex-connect-app-server.service",
      );
    } finally {
      await readiness.close();
    }
  }, 15_000);

  linuxIt("includes installed WebUI in all and waits for its readiness", async () => {
    const root = mkdtempSync(join(tmpdir(), "codex-connect-service-webui-"));
    temporaryDirectories.push(root);
    const home = join(root, ".codex-connect");
    const workspace = join(root, "Workspace");
    const systemctlLog = join(root, "systemctl.log");
    const fakeSystemctl = join(root, "systemctl");
    mkdirSync(workspace);
    writeFileSync(
      fakeSystemctl,
      "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$SYSTEMCTL_LOG\"\n",
    );
    chmodSync(fakeSystemctl, 0o755);
    const environment = {
      ...process.env,
      XDG_CONFIG_HOME: join(root, "config"),
      CODEX_CONNECT_HOME: home,
      CODEX_CONNECT_CONFIG_FILE: "",
      SYSTEMCTL_BINARY: fakeSystemctl,
      SYSTEMCTL_LOG: systemctlLog,
    };
    execFileSync(process.execPath, [cli, "init"], { cwd: workspace, env: environment });
    const readiness = await startManagedServiceReadinessFixture(
      join(home, "config.toml"),
      environment,
    );
    const webui = await startWebuiReadinessFixture(join(home, "config.toml"));
    const definitions = join(environment.XDG_CONFIG_HOME, "systemd", "user");
    mkdirSync(definitions, { recursive: true });
    writeFileSync(join(definitions, "codex-connect-webui.service"), "fixture");
    try {
        await execFileAsync(
        process.execPath,
        [cli, "start", "webui"],
        { env: environment, encoding: "utf8" },
      );
      expect(readFileSync(systemctlLog, "utf8")).toContain(
        "--user start codex-connect-webui.service",
      );

      writeFileSync(systemctlLog, "");
      const { stdout: allStdout } = await execFileAsync(
        process.execPath,
        [cli, "start", "all"],
        { env: environment, encoding: "utf8" },
      );
      expect(allStdout).toContain("全部已选后台服务已就绪");
      const log = readFileSync(systemctlLog, "utf8");
      expect(log).toContain("codex-connect-app-server.service");
      expect(log).toContain("codex-connect-gateway.service");
      expect(log).toContain("codex-connect-webui.service");
      expect(log.indexOf("start codex-connect-app-server.service")).toBeLessThan(log.indexOf("start codex-connect-gateway.service"));
      expect(log.indexOf("start codex-connect-gateway.service")).toBeLessThan(log.indexOf("start codex-connect-webui.service"));

      writeFileSync(systemctlLog, "");
      const { stdout: defaultStartStdout } = await execFileAsync(
        process.execPath,
        [cli, "start"],
        { env: environment, encoding: "utf8" },
      );
      expect(defaultStartStdout).toContain("全部已选后台服务已就绪");
      const defaultStartLog = readFileSync(systemctlLog, "utf8");
      expect(defaultStartLog).toContain("codex-connect-app-server.service");
      expect(defaultStartLog).toContain("codex-connect-gateway.service");

    } finally {
      await new Promise<void>((resolve, reject) => webui.close(error => error ? reject(error) : resolve()));
      await readiness.close();
    }
  }, 15_000);


});
