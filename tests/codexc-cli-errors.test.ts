import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  deepseekAccountDefinition
} from "../runtime/model-provider-definitions.mjs";
import { cli, mkdtempSync, table, unixSocketTmpdir, updateGatewayConfig } from "./codexc-cli-test-fixture.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("codexc CLI", { timeout: 15_000 }, () => {
  it("rejects the removed manual ds_proxy configuration", () => {
    const root = mkdtempSync(join(unixSocketTmpdir, "codex-connect-service-proxy-mode-"));
    temporaryDirectories.push(root);
    const home = join(root, ".codex-connect");
    const codexHome = join(root, ".codex");
    const workspace = join(root, "Workspace");
    const fakeCodex = join(root, "fake-codex.mjs");
    mkdirSync(workspace);
    mkdirSync(codexHome);
    writeFileSync(fakeCodex, "#!/usr/bin/env node\n");
    chmodSync(fakeCodex, 0o700);
    const providerDirectory = join(home, "providers", "deepseek", "accounts", "test");
    mkdirSync(providerDirectory, { recursive: true, mode: 0o700 });
    writeFileSync(join(home, "providers", "deepseek", "accounts.json"), JSON.stringify([{ id: "test", default: true }]), { mode: 0o600 });
    writeFileSync(
      join(providerDirectory, deepseekAccountDefinition("test").managedMarkerFileName),
      'version = 1\nprovider = "ds-test"\nmode = "exclusive"\n',
      { mode: 0o600 },
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
      document.ds_proxy = { listen: "127.0.0.1:38473" };
    });

    const result = spawnSync(process.execPath, [cli, "service-app-server"], {
      cwd: root,
      env: environment,
      encoding: "utf8",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("ds_proxy");
  });

  it("does not overwrite an existing user configuration", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-connect-cli-"));
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
    const before = readFileSync(join(home, "config.toml"), "utf8");
    const output = execFileSync(process.execPath, [cli, "init"], {
      cwd: root,
      env: environment,
      encoding: "utf8",
    });

    expect(output).toContain("已经初始化");
    expect(output).not.toContain("初始 Workspace");
    expect(readFileSync(join(home, "config.toml"), "utf8")).toBe(before);
  });

  it("rejects ignored extra arguments", () => {
    const result = spawnSync(process.execPath, [cli, "config", "unexpected"], {
      encoding: "utf8",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("用法：codexc config");
  });

  it("rejects the undocumented help alias and extra top-level help arguments", () => {
    const alias = spawnSync(process.execPath, [cli, "help"], { encoding: "utf8" });
    const extra = spawnSync(process.execPath, [cli, "--help", "unexpected"], {
      encoding: "utf8",
    });

    expect(alias.status).toBe(1);
    expect(alias.stderr).toContain("未知命令：help");
    expect(extra.status).toBe(1);
    expect(extra.stderr).toContain("用法：codexc --help");
  });



  it("rejects extra arguments instead of silently executing scoped commands", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-connect-cli-extra-"));
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
    execFileSync(process.execPath, [cli, "init"], {
      cwd: workspace,
      env: environment,
    });

    for (const [args, expected] of [
      [["work", "list", "unexpected"], "用法：codexc work list"],
    ] as const) {
      const result = spawnSync(process.execPath, [cli, ...args], {
        cwd: root,
        env: environment,
        encoding: "utf8",
      });
      expect(result.status, `${args.join(" ")}\n${result.stderr}`).toBe(1);
      expect(result.stderr).toContain(expected);
    }
  });

  it("reports a foreground start failure exactly once without a Node stack", () => {
    const root = mkdtempSync(join(unixSocketTmpdir, "codex-connect-start-error-"));
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
    updateGatewayConfig(join(home, "config.toml"), (document) => {
      const configuredWorkspaces = document.workspaces;
      if (!Array.isArray(configuredWorkspaces) || configuredWorkspaces.length === 0) {
        throw new Error("测试配置缺少 Workspace");
      }
      const configuredWorkspace = configuredWorkspaces[0];
      if (!configuredWorkspace || typeof configuredWorkspace !== "object") {
        throw new Error("测试 Workspace 配置无效");
      }
      configuredWorkspaces[0] = {
        ...configuredWorkspace,
        cwd: join(root, "Missing Workspace"),
      };
    });

    const result = spawnSync(process.execPath, [cli, "start"], {
      cwd: workspace,
      env: environment,
      encoding: "utf8",
      timeout: 10_000,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("目录不存在或不是目录");
    expect(result.stderr.match(/\[失败\]/g)).toHaveLength(1);
    expect(result.stderr).not.toContain("子命令执行失败");
    expect(result.stderr).not.toContain("Node.js v");
    expect(result.stderr).not.toContain("file://");
  });

  it.skipIf(process.platform === "win32")("reports a silent non-zero App Server exit exactly once", () => {
    const root = mkdtempSync(join(unixSocketTmpdir, "codex-connect-start-exit-"));
    temporaryDirectories.push(root);
    const home = join(root, ".codex-connect");
    const codexHome = join(root, ".codex");
    const workspace = join(root, "Workspace");
    const fakeCodex = join(root, "fake-codex.mjs");
    mkdirSync(workspace);
    mkdirSync(codexHome);
    writeFileSync(fakeCodex, "#!/usr/bin/env node\nprocess.exit(1);\n");
    chmodSync(fakeCodex, 0o700);
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

    const result = spawnSync(process.execPath, [cli, "start"], {
      cwd: workspace,
      env: environment,
      encoding: "utf8",
      timeout: 10_000,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Codex App Server 进程意外退出：exit=1");
    expect(result.stderr.match(/\[失败\]/g)).toHaveLength(1);
    expect(result.stderr).not.toContain("子命令执行失败");
    expect(result.stderr).not.toContain("Node.js v");
  });

  it("does not repeat a managed child command failure", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-connect-channel-error-"));
    temporaryDirectories.push(root);
    const home = join(root, ".codex-connect");
    const environment = {
      ...process.env,
      CODEX_CONNECT_HOME: home,
      CODEX_CONNECT_CONFIG_FILE: "",
    };
    execFileSync(process.execPath, [cli, "init"], {
      cwd: root,
      env: environment,
    });

    const result = spawnSync(
      process.execPath,
      [cli, "channel", "send-image", join(root, "missing.png")],
      { cwd: root, env: environment, encoding: "utf8" },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("图片文件不存在");
    expect(result.stderr.match(/\[失败\]/g)).toHaveLength(1);
    expect(result.stderr).not.toContain("子命令执行失败");
  });

  it("does not repeat a metrics status failure reported by the child command", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-connect-metrics-status-error-"));
    temporaryDirectories.push(root);
    const configPath = join(root, "invalid.toml");
    writeFileSync(configPath, "[\n");

    const result = spawnSync(process.execPath, [cli, "metrics", "status"], {
      env: {
        ...process.env,
        CODEX_CONNECT_CONFIG_FILE: configPath,
      },
      encoding: "utf8",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("语法无效");
    expect(result.stderr.match(/\[失败\]/g)).toHaveLength(1);
    expect(result.stderr).not.toContain("子命令执行失败");
  });

  it("formats a managed WebUI child failure exactly once", async () => {
    const root = mkdtempSync(join(tmpdir(), "codex-connect-managed-error-"));
    temporaryDirectories.push(root);
    const home = join(root, ".codex-connect");
    const workspace = join(root, "Workspace");
    mkdirSync(workspace);
    const environment = {
      ...process.env,
      CODEX_CONNECT_HOME: home,
      CODEX_CONNECT_CONFIG_FILE: "",
      CODEX_CONNECT_SERVICE_ROLE: "",
    };
    execFileSync(process.execPath, [cli, "init"], {
      cwd: workspace,
      env: environment,
    });
    const blocker = createServer();
    await new Promise<void>((resolveListen, rejectListen) => {
      blocker.once("error", rejectListen);
      blocker.listen(0, "127.0.0.1", resolveListen);
    });
    const address = blocker.address();
    if (!address || typeof address === "string") throw new Error("测试端口无效");

    let result;
    try {
      result = spawnSync(
        process.execPath,
        [cli, "webui", "--port", String(address.port)],
        { cwd: workspace, env: environment, encoding: "utf8" },
      );
    } finally {
      await new Promise<void>((resolveClose) => blocker.close(() => resolveClose()));
    }

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("WebUI 启动失败");
    expect(result.stderr.match(/\[失败\]/g)).toHaveLength(1);
    expect(result.stderr).not.toContain("子命令执行失败");
  });


});
