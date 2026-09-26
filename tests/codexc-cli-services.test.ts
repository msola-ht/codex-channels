import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";

import { resolveAppServerRuntime } from "../runtime/app-server-runtime.mjs";
import { AppServerSupervisorOwner } from "../runtime/app-server-supervisor.mjs";
import { readGatewayConfig } from "../runtime/gateway-config.mjs";
import { GatewayOwner } from "../runtime/gateway-owner.mjs";
import { DeliveryJournal } from "../src/surfaces/index.js";
import { cli, execFileAsync, mkdtempSync, updateGatewayConfig } from "./codexc-cli-test-fixture.js";

const linuxIt = process.platform === "linux" ? it : it.skip;
const temporaryDirectories: string[] = [];

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
  it("rejects invalid service log options before reading user configuration", () => {
    const invalidLines = spawnSync(process.execPath, [cli, "service", "logs", "--lines", "0"], {
      encoding: "utf8",
    });
    const unknown = spawnSync(process.execPath, [cli, "service", "logs", "--unknown"], {
      encoding: "utf8",
    });
    const removedServiceOption = spawnSync(
      process.execPath,
      [cli, "service", "logs", "--service", "all"],
      { encoding: "utf8" },
    );
    const invalidTarget = spawnSync(
      process.execPath,
      [cli, "service", "restart", "unknown"],
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
      "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$SYSTEMCTL_LOG\"\n",
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
      ["restart", "app-server"],
      ["restart", "all"],
      ["stop", "gateway"],
      ["stop", "app-server"],
      ["stop", "all"],
      ["install"],
      ["uninstall"],
    ]) {
      const result = spawnSync(
        process.execPath,
        [cli, "service", ...args],
        { cwd: workspace, env: environment, encoding: "utf8" },
      );
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("不能在 Codex App Server 内执行会中断当前渠道的服务操作");
    }
    expect(existsSync(systemctlLog) ? readFileSync(systemctlLog, "utf8") : "").toBe("");

    const readiness = await startManagedServiceReadinessFixture(
      join(home, "config.toml"),
      environment,
    );
    updateGatewayConfig(join(home, "config.toml"), document => {
      document.telegram = { bot_token: "123:fixture", allowed_user_ids: [1], message_format: "html" };
    });
    const journal = new DeliveryJournal(join(home, "data", "delivery-v1"));
    journal.fail();
    try {
      const { stdout } = await execFileAsync(
        process.execPath,
        [cli, "service", "restart", "gateway"],
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
      expect(stdout).toContain("恢复保护=开启");
      expect(stdout).toContain("codexc delivery status --json");
      expect(readFileSync(systemctlLog, "utf8")).toContain(
        "--user restart codex-connect-gateway.service",
      );
      expect(readFileSync(systemctlLog, "utf8")).not.toContain(
        "codex-connect-app-server.service",
      );
    } finally {
      journal.close();
      await readiness.close();
    }
  }, 15_000);

  linuxIt("manages WebUI as an independent service target outside all", async () => {
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

    try {
      const start = spawnSync(
        process.execPath,
        [cli, "service", "start", "webui"],
        { env: environment, encoding: "utf8" },
      );
      expect(start.status).toBe(0);
      expect(readFileSync(systemctlLog, "utf8")).toContain(
        "--user start codex-connect-webui.service",
      );

      writeFileSync(systemctlLog, "");
      const { stdout: allStdout } = await execFileAsync(
        process.execPath,
        [cli, "service", "start", "all"],
        { env: environment, encoding: "utf8" },
      );
      expect(allStdout).toContain("Codex App Server 与 Gateway 已就绪");
      const log = readFileSync(systemctlLog, "utf8");
      expect(log).toContain("codex-connect-app-server.service");
      expect(log).toContain("codex-connect-gateway.service");
      expect(log).not.toContain("codex-connect-webui.service");

      writeFileSync(systemctlLog, "");
      const { stdout: defaultStartStdout } = await execFileAsync(
        process.execPath,
        [cli, "service", "start"],
        { env: environment, encoding: "utf8" },
      );
      expect(defaultStartStdout).toContain("Codex App Server 与 Gateway 已就绪");
      const defaultStartLog = readFileSync(systemctlLog, "utf8");
      expect(defaultStartLog).toContain("codex-connect-app-server.service");
      expect(defaultStartLog).toContain("codex-connect-gateway.service");

      writeFileSync(systemctlLog, "");
      const { stdout: defaultRestartStdout } = await execFileAsync(
        process.execPath,
        [cli, "service", "restart"],
        { env: environment, encoding: "utf8" },
      );
      expect(defaultRestartStdout).toContain("Gateway 已就绪；Codex App Server 保持运行");
      const defaultRestartLog = readFileSync(systemctlLog, "utf8");
      expect(defaultRestartLog).toContain("codex-connect-gateway.service");
      expect(defaultRestartLog).not.toContain("codex-connect-app-server.service");
    } finally {
      await readiness.close();
    }
  }, 15_000);


});
