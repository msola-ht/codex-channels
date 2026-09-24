import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { writeCodexProxySettings } from "../runtime/codex-proxy-env.mjs";

import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";

import { AppServerSupervisorOwner } from "../runtime/app-server-supervisor.mjs";
import { readGatewayConfig } from "../runtime/gateway-config.mjs";
import {
  EncryptedFileWeixinCredentialStore,
  EncryptedFileWeixinReplyContextPersistence,
  FileWeixinUpdatesCursorStore,
} from "../src/surfaces/weixin/index.js";
import {
  cli,
  execFileAsync,
  forEachWithConcurrency,
  mkdtempSync,
  runCliProcess,
  table,
  unixSocketTmpdir,
  updateGatewayConfig,
} from "./codexc-cli-test-fixture.js";

const linuxIt = process.platform === "linux" ? it : it.skip;
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

if (process.platform === "win32") {
  describe.skip("codexc CLI doctor (Unix-only fixtures)", () => {
    it.skip("requires a dedicated Windows Doctor contract", () => undefined);
  });
} else {
  describe("codexc CLI", { timeout: 15_000 }, () => {
  it("rejects removed commands and Workspace aliases", async () => {
    await forEachWithConcurrency(["workspace", "ws", "agents"], 3, async (alias) => {
      const result = await runCliProcess([alias]);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`未知命令：${alias}`);
    });
  });

  it("shows an explicitly configured Gateway config file", async () => {
    const root = mkdtempSync(join(tmpdir(), "codex-connect-cli-"));
    temporaryDirectories.push(root);
    const configPath = join(root, "profile", "gateway.toml");
    mkdirSync(join(root, "profile"));
    const options = {
      env: { ...process.env, CODEX_CONNECT_CONFIG_FILE: configPath },
      encoding: "utf8" as const,
    };
    const outputs = new Map<string, string>();
    await forEachWithConcurrency([[], ["--json"]], 2, async (args) => {
      const { stdout } = await execFileAsync(process.execPath, [cli, "config", ...args], options);
      outputs.set(args.join(" "), stdout);
    });

    expect(outputs.get("")).toContain(`用户目录：${join(root, "profile")}`);
    expect(outputs.get("")).toContain(`配置文件：${configPath}`);
    expect(JSON.parse(outputs.get("--json")!)).toEqual({
      dataDir: join(root, "profile"),
      configPath,
      exists: false,
    });
  });

  it("initializes an explicitly configured Gateway config file", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-connect-cli-"));
    temporaryDirectories.push(root);
    const workspace = join(root, "Workspace");
    const profile = join(root, "profile");
    const configPath = join(profile, "gateway.toml");
    mkdirSync(workspace);
    mkdirSync(profile, { mode: 0o755 });
    chmodSync(profile, 0o755);

    const output = execFileSync(process.execPath, [cli, "init"], {
      cwd: workspace,
      env: { ...process.env, CODEX_CONNECT_CONFIG_FILE: configPath },
      encoding: "utf8",
    });
    execFileSync(process.execPath, [cli, "work"], {
      cwd: workspace,
      env: { ...process.env, CODEX_CONNECT_CONFIG_FILE: configPath },
    });
    const diagnosed = spawnSync(process.execPath, [cli, "doctor"], {
      cwd: workspace,
      env: { ...process.env, CODEX_CONNECT_CONFIG_FILE: configPath },
      encoding: "utf8",
    });

    const parsed = readGatewayConfig(configPath);
    const jsonOutput = execFileSync(process.execPath, [cli, "config", "--json"], {
      env: { ...process.env, CODEX_CONNECT_CONFIG_FILE: configPath },
      encoding: "utf8",
    });
    expect(output).toContain(`配置文件：${configPath}`);
    expect(JSON.parse(jsonOutput)).toEqual({
      dataDir: profile,
      configPath,
      exists: true,
    });
    expect(table(parsed.codex).socket_path).toBe("runtime/codex-app-server.sock");
    expect(table(parsed.storage).database_path).toBe("data/gateway.sqlite3");
    expect(statSync(profile).mode & 0o777).toBe(0o755);
    expect(statSync(join(profile, "runtime")).mode & 0o777).toBe(0o700);
    expect(statSync(join(profile, "data")).mode & 0o777).toBe(0o700);
    expect(statSync(configPath).mode & 0o777).toBe(0o600);
    expect(diagnosed.stdout).not.toContain("[失败] 配置目录权限");
  });

  it("reports Telegram as disabled when another channel is enabled", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-connect-doctor-channel-"));
    temporaryDirectories.push(root);
    const home = join(root, ".codex-connect");
    const workspace = join(root, "Workspace");
    mkdirSync(workspace);
    const environment = {
      ...process.env,
      CODEX_CONNECT_HOME: home,
      CODEX_CONNECT_CONFIG_FILE: "",
    };
    execFileSync(process.execPath, [cli, "init"], { cwd: workspace, env: environment });
    Object.assign(environment, { CODEX_HOME: join(root, ".codex") });
    updateGatewayConfig(join(home, "config.toml"), (document) => {
      writeCodexProxySettings({ https_proxy: "http://127.0.0.1:7890" }, environment);
      document.weixin = {
        enabled: true,
        account_id: "bot-fixture@im.bot",
        allowed_user_ids: ["actor-fixture@im.wechat"],
      };
    });

    const diagnosed = spawnSync(process.execPath, [cli, "doctor"], {
      cwd: workspace,
      env: environment,
      encoding: "utf8",
    });

    expect(diagnosed.stdout).not.toContain("[通过] 配置格式");
    expect(diagnosed.stdout).toContain("[提示] Telegram：未配置");
    expect(diagnosed.stdout).toContain(
      "[提示] Plugin API：已关闭",
    );
    expect(diagnosed.stdout).toContain(
      "[提示] OpenAI 代理：已检测到代理，官方模型请求将通过代理连接",
    );
    expect(diagnosed.stdout).not.toContain("[失败] Telegram Token");
    expect(diagnosed.stdout).not.toContain("[失败] Telegram 用户");
    expect(diagnosed.stdout).not.toContain("[通过]");
    expect(diagnosed.stdout.match(/诊断发现/g)).toHaveLength(1);
    const visibleSections = [
      "=== 网络与代理 ===",
      "=== 通讯渠道 ===",
      "=== 扩展能力 ===",
      "=== Codex 与 App Server ===",
      "=== 系统服务 ===",
    ];
    expect(visibleSections.every((section) => diagnosed.stdout.includes(section))).toBe(true);
    expect(visibleSections.map((section) => diagnosed.stdout.indexOf(section))).toEqual(
      [...visibleSections]
        .map((section) => diagnosed.stdout.indexOf(section))
        .sort((left, right) => left - right),
    );
    expect(diagnosed.stdout).not.toContain("=== Workspace ===");
    expect(diagnosed.stdout).not.toContain(`${String.fromCharCode(27)}[`);
    expect(diagnosed.stdout).toMatch(/诊断发现 \d+ 项问题：\d+ 项通过，\d+ 项提示。/u);
  });

  it("prints structured Doctor results without exposing configured secrets", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-connect-doctor-json-"));
    temporaryDirectories.push(root);
    const home = join(root, ".codex-connect");
    const workspace = join(root, "Workspace");
    mkdirSync(workspace);
    const environment = {
      ...process.env,
      CODEX_CONNECT_HOME: home,
      CODEX_CONNECT_CONFIG_FILE: "",
    };
    execFileSync(process.execPath, [cli, "init"], { cwd: workspace, env: environment });
    const secret = "doctor-json-secret-token";
    updateGatewayConfig(join(home, "config.toml"), (document) => {
      const telegram = table(document.telegram);
      telegram.bot_token = secret;
      telegram.allowed_user_ids = [123456];
      document.experimental = { plugin_api: true };
    });

    const diagnosed = spawnSync(process.execPath, [cli, "doctor", "--json"], {
      cwd: workspace,
      env: environment,
      encoding: "utf8",
    });

    const payload = JSON.parse(diagnosed.stdout) as {
      healthy: boolean;
      counts: { success: number; failure: number; note: number };
      checks: Array<{
        section: string;
        kind: "success" | "failure" | "note";
        name: string;
        detail: string;
        remediation: string | null;
      }>;
    };
    expect(diagnosed.status).toBe(payload.healthy ? 0 : 1);
    expect(payload.checks).toHaveLength(
      payload.counts.success + payload.counts.failure + payload.counts.note,
    );
    expect(payload.checks).toContainEqual(expect.objectContaining({
      section: "通讯渠道",
      kind: "success",
      name: "Telegram Token",
      remediation: null,
    }));
    expect(payload.checks).toContainEqual(expect.objectContaining({
      section: "扩展能力",
      kind: "note",
      name: "Plugin API",
      detail: expect.stringContaining("Codex 0.156.1"),
    }));
    expect(diagnosed.stdout).not.toContain(secret);
    expect(diagnosed.stdout).not.toContain("Codex Connect Doctor\n");
    expect(diagnosed.stderr).toBe("");
  });

  linuxIt("reports how to install bubblewrap when it is missing from PATH", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-connect-doctor-bwrap-"));
    temporaryDirectories.push(root);
    const emptyPath = join(root, "bin");
    mkdirSync(emptyPath);

    const diagnosed = spawnSync(process.execPath, [cli, "doctor"], {
      cwd: root,
      env: {
        ...process.env,
        PATH: emptyPath,
        CODEX_CONNECT_HOME: join(root, ".codex-connect"),
        CODEX_CONNECT_CONFIG_FILE: "",
      },
      encoding: "utf8",
    });

    expect(diagnosed.stdout).toContain(
      "[提示] Linux 沙箱：PATH 中未找到 bwrap；Codex 将回退到内置 helper",
    );
    expect(diagnosed.stdout).toContain(
      "[处理] Linux 沙箱：Debian/Ubuntu：sudo apt install bubblewrap；"
      + "Fedora/RHEL：sudo dnf install bubblewrap；安装后重新运行 codexc doctor",
    );
  });

  linuxIt("warns when OpenAI will use a direct connection without a proxy", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-connect-doctor-proxy-"));
    temporaryDirectories.push(root);
    const home = join(root, ".codex-connect");
    const codexHome = join(root, ".codex");
    const workspace = join(root, "Workspace");
    const emptyPath = join(root, "bin");
    mkdirSync(workspace);
    mkdirSync(codexHome);
    mkdirSync(emptyPath);
    const environment = {
      ...process.env,
      CODEX_CONNECT_HOME: home,
      CODEX_CONNECT_CONFIG_FILE: "",
      CODEX_HOME: codexHome,
    };
    execFileSync(process.execPath, [cli, "init"], { cwd: workspace, env: environment });
    updateGatewayConfig(join(home, "config.toml"), (document) => {
      const telegram = table(document.telegram);
      telegram.bot_token = "doctor-proxy-fixture";
      telegram.allowed_user_ids = [123456];
    });

    const diagnosed = spawnSync(process.execPath, [cli, "doctor"], {
      cwd: workspace,
      env: {
        ...environment,
        PATH: emptyPath,
        HTTP_PROXY: "",
        HTTPS_PROXY: "",
        ALL_PROXY: "",
        NO_PROXY: "",
        http_proxy: "",
        https_proxy: "",
        all_proxy: "",
        no_proxy: "",
      },
      encoding: "utf8",
    });

    expect(diagnosed.stdout).toContain(
      "[提示] OpenAI 代理：未检测到代理，官方模型请求将尝试直连；受限网络中可能无法连接",
    );
    expect(diagnosed.stdout).toContain(
      "[处理] OpenAI 代理：运行 codexc config 在 Codex .env 中设置 HTTPS_PROXY",
    );
  });

  linuxIt("reports safe Linux Weixin runtime readiness without exposing private values", async () => {
    const root = mkdtempSync(join(tmpdir(), "codex-connect-doctor-weixin-"));
    temporaryDirectories.push(root);
    const home = join(root, ".codex-connect");
    const workspace = join(root, "Workspace");
    mkdirSync(workspace);
    const environment = {
      ...process.env,
      CODEX_CONNECT_HOME: home,
      CODEX_CONNECT_CONFIG_FILE: "",
    };
    execFileSync(process.execPath, [cli, "init"], {
      cwd: workspace,
      env: environment,
    });
    const configPath = join(home, "config.toml");
    updateGatewayConfig(configPath, (document) => {
      const telegram = table(document.telegram);
      telegram.bot_token = "test-token";
      telegram.allowed_user_ids = [123456];
      document.weixin = {
        enabled: true,
        account_id: "bot-fixture@im.bot",
        allowed_user_ids: ["actor-fixture@im.wechat"],
      };
    });
    const accountId = "bot-fixture@im.bot";
    const actorId = "actor-fixture@im.wechat";
    const botToken = "private-bot-token";
    const contextToken = "private-context-token";
    const cursor = "private-updates-cursor";
    await new EncryptedFileWeixinCredentialStore(
      join(home, "credentials", "weixin"),
    ).set({
      version: 1,
      accountId,
      botToken,
      baseUrl: "https://ilinkai.weixin.qq.com",
      grantedAt: 1_000,
    });
    await new EncryptedFileWeixinReplyContextPersistence(
      join(home, "credentials", "weixin-reply-context"),
      () => 1_000,
    ).set(
      {
        surface: "weixin",
        accountId,
        conversationId: actorId,
      },
      actorId,
      contextToken,
    );
    await new FileWeixinUpdatesCursorStore(
      join(home, "data", "weixin-updates"),
    ).set(accountId, cursor);

    const enabled = spawnSync(process.execPath, [cli, "doctor"], {
      cwd: workspace,
      env: environment,
      encoding: "utf8",
    });
    expect(enabled.stdout).toContain(
      "[提示] 微信运行时：配置已启用",
    );
    expect(enabled.stdout).not.toContain("[失败] 微信配置");
    expect(enabled.stdout).not.toContain("[失败] 微信连接");
    expect(enabled.stdout).toContain(
      "[提示] 微信消息游标：检查点存在且载荷有效",
    );
    expect(enabled.stdout).toContain(
      "[提示] 微信上线通知：1/1 个允许用户具备加密回复上下文",
    );
    expect(enabled.stdout).toContain(
      "最近授权消息：1970-01-01T00:00:01.000Z",
    );
    expect(enabled.stdout).not.toContain(botToken);
    expect(enabled.stdout).not.toContain(contextToken);
    expect(enabled.stdout).not.toContain(cursor);
    expect(enabled.stdout).not.toContain(accountId);
    expect(enabled.stdout).not.toContain(actorId);

    updateGatewayConfig(configPath, (document) => {
      table(document.weixin).enabled = false;
    });
    const disabled = spawnSync(process.execPath, [cli, "doctor"], {
      cwd: workspace,
      env: environment,
      encoding: "utf8",
    });
    expect(disabled.stdout).toContain(
      "[提示] 微信运行时：配置未启用",
    );
  });

  it("diagnoses configuration and a real Unix WebSocket without exposing the Telegram token", async () => {
    const root = mkdtempSync(join(unixSocketTmpdir, "codex-connect-doctor-"));
    temporaryDirectories.push(root);
    const home = join(root, ".codex-connect");
    const codexHome = join(root, ".codex");
    const workspace = join(root, "Workspace");
    mkdirSync(workspace);
    mkdirSync(codexHome);
    const environment = {
      ...process.env,
      CODEX_CONNECT_HOME: home,
      CODEX_CONNECT_CONFIG_FILE: "",
      CODEX_HOME: codexHome,
    };
    execFileSync(process.execPath, [cli, "init"], { cwd: workspace, env: environment });

    const expectedCodexCliVersion = (
      JSON.parse(
        readFileSync(resolve("src/codex-protocol/version.json"), "utf8"),
      ) as { codexCli: string }
    ).codexCli;
    const expectedAppServerVersion = expectedCodexCliVersion.replace(/^codex-cli /u, "");
    const fakeCodex = join(root, "codex");
    writeFileSync(
      fakeCodex,
      `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(`${expectedCodexCliVersion}\n`)});\n`,
    );
    chmodSync(fakeCodex, 0o700);
    const configPath = join(home, "config.toml");
    const socketPath = join(root, "app.sock");
    let initializedReceived = false;
    const initializedClientNames: unknown[] = [];
    let appServerVersion = expectedAppServerVersion;
    const secret = "123456:test-secret-token";
    updateGatewayConfig(configPath, (document) => {
      const telegram = table(document.telegram);
      telegram.bot_token = secret;
      telegram.allowed_user_ids = [123456];
      const codex = table(document.codex);
      codex.binary = fakeCodex;
      codex.socket_path = socketPath;
    });

    const server = createServer();
    const webSocketServer = new WebSocketServer({ server });
    webSocketServer.on("connection", (client) => {
      client.on("message", (data) => {
        const message = JSON.parse(data.toString());
        if (message.method === "initialize") {
          initializedClientNames.push(message.params?.clientInfo?.name);
          client.send(JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              userAgent: `codex_cli_rs/${appServerVersion} (macOS 26.0; arm64)`,
              codexHome: home,
              platformFamily: "unix",
              platformOs: "macos",
            },
          }));
        }
        if (message.method === "initialized") {
          initializedReceived = true;
        }
      });
    });
    await new Promise<void>((resolveListen, rejectListen) => {
      server.once("error", rejectListen);
      server.listen(socketPath, resolveListen);
    });
    const supervisorOwner = new AppServerSupervisorOwner(socketPath, {
      primaryProvider: "openai",
      managedProviders: [],
      socketPaths: [socketPath],
    });

    try {
      const unmanaged = await execFileAsync(
        process.execPath,
        [cli, "doctor"],
        { cwd: workspace, env: environment, encoding: "utf8" },
      ).then(
        ({ stdout }) => ({ status: 0, stdout }),
        (error: Error & { code?: number; stdout?: string }) => ({
          status: error.code,
          stdout: error.stdout ?? "",
        }),
      );
      expect(unmanaged.status).toBe(1);
      expect(unmanaged.stdout).toContain("[失败] App Server 监管");
      expect(unmanaged.stdout).toContain("codexc service restart all");

      await supervisorOwner.start();
      const { stdout } = await execFileAsync(
        process.execPath,
        [cli, "doctor"],
        {
          cwd: workspace,
          env: environment,
          encoding: "utf8",
        },
      ).catch((error: Error & { stdout?: string; stderr?: string }) => {
        throw new Error(
          `doctor 执行失败\n${error.stdout ?? ""}\n${error.stderr ?? ""}`,
          { cause: error },
        );
      });
      expect(stdout).not.toContain("[失败] Codex CLI");
      expect(stdout).not.toContain("[失败] Codex App Server");
      expect(stdout).not.toContain("[失败] App Server 版本");
      expect(stdout).not.toContain("[通过]");
      expect(stdout).toContain("诊断通过");
      expect(stdout).not.toContain(secret);
      expect(initializedReceived).toBe(true);
      expect(initializedClientNames.length).toBeGreaterThan(0);
      expect(initializedClientNames.every((name) => name === "codex_app_server_daemon")).toBe(true);

      appServerVersion = "0.0.0";
      const mismatched = await execFileAsync(
        process.execPath,
        [cli, "doctor"],
        {
          cwd: workspace,
          env: environment,
          encoding: "utf8",
        },
      ).then(
        ({ stdout: mismatchStdout }) => ({ status: 0, stdout: mismatchStdout }),
        (error: Error & { code?: number; stdout?: string }) => ({
          status: error.code,
          stdout: error.stdout ?? "",
        }),
      );
      expect(mismatched.status).toBe(1);
      expect(mismatched.stdout).toContain(
        `[失败] App Server 版本：0.0.0（要求 ${expectedAppServerVersion}）`,
      );
    } finally {
      await supervisorOwner.close();
      for (const client of webSocketServer.clients) {
        client.terminate();
      }
      await new Promise<void>((resolveClose) => webSocketServer.close(() => resolveClose()));
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }
  });

  it("rejects the removed doctor --fix compatibility command", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-connect-doctor-fix-"));
    temporaryDirectories.push(root);
    const home = join(root, ".codex-connect");
    const workspace = join(root, "Workspace");
    mkdirSync(workspace);
    const environment = {
      ...process.env,
      CODEX_CONNECT_HOME: home,
      CODEX_CONNECT_CONFIG_FILE: "",
    };
    execFileSync(process.execPath, [cli, "init"], { cwd: workspace, env: environment });

    const rejected = spawnSync(process.execPath, [cli, "doctor", "--fix"], {
      cwd: workspace,
      env: environment,
      encoding: "utf8",
    });

    expect(rejected.status).toBe(1);
    expect(rejected.stderr).toContain("用法：codexc doctor");
  });

  it("reports invalid TOML without rewriting it", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-connect-doctor-legacy-"));
    temporaryDirectories.push(root);
    const home = join(root, ".codex-connect");
    const workspace = join(root, "Workspace");
    mkdirSync(workspace);
    const environment = {
      ...process.env,
      CODEX_CONNECT_HOME: home,
      CODEX_CONNECT_CONFIG_FILE: "",
    };
    execFileSync(process.execPath, [cli, "init"], { cwd: workspace, env: environment });
    const configPath = join(home, "config.toml");
    const invalidContent = `${readFileSync(configPath, "utf8")}\ninvalid = [\n`;
    writeFileSync(configPath, invalidContent);

    const diagnosed = spawnSync(process.execPath, [cli, "doctor"], {
      cwd: workspace,
      env: environment,
      encoding: "utf8",
    });

    expect(diagnosed.status).toBe(1);
    expect(diagnosed.stdout).toContain("[失败] 配置格式");
    expect(readFileSync(configPath, "utf8")).toBe(invalidContent);
  });

  it("rejects configuration that is valid TOML but violates the Gateway schema", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-connect-doctor-schema-"));
    temporaryDirectories.push(root);
    const home = join(root, ".codex-connect");
    const workspace = join(root, "Workspace");
    mkdirSync(workspace);
    const environment = {
      ...process.env,
      CODEX_CONNECT_HOME: home,
      CODEX_CONNECT_CONFIG_FILE: "",
    };
    execFileSync(process.execPath, [cli, "init"], { cwd: workspace, env: environment });
    const configPath = join(home, "config.toml");
    updateGatewayConfig(configPath, (document) => {
      document.legacy_setting = true;
    });

    const diagnosed = spawnSync(process.execPath, [cli, "doctor"], {
      cwd: workspace,
      env: environment,
      encoding: "utf8",
    });

    expect(diagnosed.status).toBe(1);
    expect(diagnosed.stdout).toContain("[失败] 配置格式");
    expect(diagnosed.stdout).toContain("Unrecognized key");
  });

  it("reports removed Thread Section configuration as invalid", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-connect-doctor-section-admin-"));
    temporaryDirectories.push(root);
    const home = join(root, ".codex-connect");
    const workspace = join(root, "Workspace");
    mkdirSync(workspace);
    const environment = {
      ...process.env,
      CODEX_CONNECT_HOME: home,
      CODEX_CONNECT_CONFIG_FILE: "",
    };
    execFileSync(process.execPath, [cli, "init"], { cwd: workspace, env: environment });
    const configPath = join(home, "config.toml");
    updateGatewayConfig(configPath, (document) => {
      const telegram = table(document.telegram);
      telegram.bot_token = "test-token";
      telegram.allowed_user_ids = [123456];
      document.thread_sections = { administrators: ["telegram:654321"] };
    });

    const diagnosed = spawnSync(process.execPath, [cli, "doctor"], {
      cwd: workspace,
      env: environment,
      encoding: "utf8",
    });

    expect(diagnosed.status).toBe(1);
    expect(diagnosed.stdout).toContain("[失败] 配置格式");
    expect(diagnosed.stdout).toContain("Unrecognized key");
    expect(diagnosed.stdout).not.toContain("管理员");
  });

});
}
