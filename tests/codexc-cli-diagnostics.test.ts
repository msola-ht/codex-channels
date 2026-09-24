import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { cli, mkdtempSync } from "./codexc-cli-test-fixture.js";

const linuxIt = process.platform === "linux" ? it : it.skip;
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("codexc CLI", { timeout: 15_000 }, () => {

  linuxIt("does not repeat a service status failure from the platform controller", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-connect-service-status-error-"));
    temporaryDirectories.push(root);
    const home = join(root, ".codex-connect");
    const workspace = join(root, "Workspace");
    const fakeSystemctl = join(root, "systemctl");
    mkdirSync(workspace);
    writeFileSync(fakeSystemctl, [
      "#!/bin/sh",
      "printf '测试服务未运行\\n' >&2",
      "exit 3",
    ].join("\n"));
    chmodSync(fakeSystemctl, 0o755);
    const environment = {
      ...process.env,
      CODEX_CONNECT_HOME: home,
      CODEX_CONNECT_CONFIG_FILE: "",
      CODEX_CONNECT_SERVICE_ROLE: "",
      SYSTEMCTL_BINARY: fakeSystemctl,
    };
    execFileSync(process.execPath, [cli, "init"], {
      cwd: workspace,
      env: environment,
    });

    const result = spawnSync(
      process.execPath,
      [cli, "service", "status", "gateway"],
      { cwd: workspace, env: environment, encoding: "utf8" },
    );

    expect(result.status, result.stderr).toBe(3);
    expect(result.stderr).toContain("测试服务未运行");
    expect(result.stderr.match(/\[失败\]/g)).toHaveLength(1);
    expect(result.stderr).not.toContain("子命令执行失败");

    const reload = spawnSync(
      process.execPath,
      [cli, "service", "reload"],
      { cwd: workspace, env: environment, encoding: "utf8" },
    );

    expect(reload.status).toBe(1);
    expect(reload.stderr).toContain("Gateway 尚未运行");
    expect(reload.stderr.match(/\[失败\]/g)).toHaveLength(1);
    expect(reload.stderr).not.toContain("子命令执行失败");
  });

  linuxIt("prints stable JSON for systemd service status", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-connect-service-status-json-"));
    temporaryDirectories.push(root);
    const fakeSystemctl = join(root, "systemctl");
    writeFileSync(fakeSystemctl, [
      "#!/bin/sh",
      "printf 'LoadState=loaded\\nActiveState=active\\nSubState=running\\nMainPID=456\\n'",
    ].join("\n"));
    chmodSync(fakeSystemctl, 0o755);

    const result = spawnSync(
      process.execPath,
      [cli, "service", "status", "gateway", "--json"],
      {
        cwd: root,
        env: { ...process.env, SYSTEMCTL_BINARY: fakeSystemctl },
        encoding: "utf8",
      },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      platform: "systemd",
      target: "gateway",
      healthy: true,
      services: [{
        target: "gateway",
        name: "Gateway",
        identifier: "codex-connect-gateway.service",
        loaded: true,
        running: true,
        state: "active/running",
        pid: 456,
      }],
    });
    expect(result.stderr).toBe("");

    writeFileSync(fakeSystemctl, [
      "#!/bin/sh",
      "printf 'LoadState=loaded\\nActiveState=inactive\\nSubState=dead\\nMainPID=0\\n'",
    ].join("\n"));
    const inactive = spawnSync(
      process.execPath,
      [cli, "service", "status", "gateway", "--json"],
      {
        cwd: root,
        env: { ...process.env, SYSTEMCTL_BINARY: fakeSystemctl },
        encoding: "utf8",
      },
    );

    expect(inactive.status).toBe(1);
    expect(JSON.parse(inactive.stdout)).toMatchObject({
      platform: "systemd",
      target: "gateway",
      healthy: false,
      services: [{ running: false, state: "inactive/dead", pid: null }],
    });
    expect(inactive.stderr).toBe("");
  });

  linuxIt("does not repeat a nested service failure from metrics maintenance", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-connect-metrics-service-error-"));
    temporaryDirectories.push(root);
    const home = join(root, ".codex-connect");
    const workspace = join(root, "Workspace");
    const fakeSystemctl = join(root, "systemctl");
    mkdirSync(workspace);
    writeFileSync(fakeSystemctl, [
      "#!/bin/sh",
      "printf '测试 Gateway 停止失败\\n' >&2",
      "exit 3",
    ].join("\n"));
    chmodSync(fakeSystemctl, 0o755);
    const environment = {
      ...process.env,
      CODEX_CONNECT_HOME: home,
      CODEX_CONNECT_CONFIG_FILE: "",
      CODEX_CONNECT_SERVICE_ROLE: "",
      SYSTEMCTL_BINARY: fakeSystemctl,
    };
    execFileSync(process.execPath, [cli, "init"], {
      cwd: workspace,
      env: environment,
    });

    const result = spawnSync(
      process.execPath,
      [cli, "metrics", "cleanup", "--restart-gateway"],
      { cwd: workspace, env: environment, encoding: "utf8" },
    );

    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain("测试 Gateway 停止失败");
    expect(result.stderr.match(/\[失败\]/g)).toHaveLength(1);
    expect(result.stderr).not.toContain("Gateway 停止失败：exit");
  });

  linuxIt("keeps service diagnostics and recovery available without a config file", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-connect-service-recovery-"));
    temporaryDirectories.push(root);
    const home = join(root, ".codex-connect");
    const systemctlLog = join(root, "systemctl.log");
    const journalctlLog = join(root, "journalctl.log");
    const fakeSystemctl = join(root, "systemctl");
    const fakeJournalctl = join(root, "journalctl");
    writeFileSync(fakeSystemctl, [
      "#!/bin/sh",
      "printf '%s\\n' \"$*\" >> \"$SYSTEMCTL_LOG\"",
    ].join("\n"));
    chmodSync(fakeSystemctl, 0o755);
    writeFileSync(fakeJournalctl, [
      "#!/bin/sh",
      "printf '%s\\n' \"$*\" >> \"$JOURNALCTL_LOG\"",
    ].join("\n"));
    chmodSync(fakeJournalctl, 0o755);
    const environment = {
      ...process.env,
      CODEX_CONNECT_HOME: home,
      CODEX_CONNECT_CONFIG_FILE: join(home, "missing.toml"),
      CODEX_CONNECT_SERVICE_ROLE: "",
      XDG_CONFIG_HOME: join(root, "config"),
      SYSTEMCTL_BINARY: fakeSystemctl,
      JOURNALCTL_BINARY: fakeJournalctl,
      SYSTEMCTL_LOG: systemctlLog,
      JOURNALCTL_LOG: journalctlLog,
    };

    for (const args of [
      ["status", "gateway"],
      ["logs", "gateway", "-n", "1"],
      ["reload"],
      ["stop", "gateway"],
      ["uninstall"],
    ]) {
      const result = spawnSync(
        process.execPath,
        [cli, "service", ...args],
        { env: environment, encoding: "utf8" },
      );
      expect(result.status, `${args.join(" ")}\n${result.stderr}`).toBe(0);
      expect(result.stderr).not.toContain("ENOENT");
      expect(result.stderr).not.toContain("尚未初始化");
    }
    expect(readFileSync(systemctlLog, "utf8")).toContain(
      "--user stop codex-connect-gateway.service",
    );
    expect(readFileSync(journalctlLog, "utf8")).toContain(
      "--user-unit=codex-connect-gateway.service --lines=1 --no-pager",
    );

    const systemctlCallsBeforeStart = readFileSync(systemctlLog, "utf8");
    const start = spawnSync(
      process.execPath,
      [cli, "service", "start", "gateway"],
      { env: environment, encoding: "utf8" },
    );
    expect(start.status).toBe(1);
    expect(start.stderr).toContain("ENOENT");
    expect(readFileSync(systemctlLog, "utf8")).toBe(systemctlCallsBeforeStart);
  });

  it("documents service maintenance commands in scoped help", () => {
    const output = execFileSync(process.execPath, [cli, "service", "--help"], {
      encoding: "utf8",
    });

    expect(output).toContain("uninstall");
    expect(output).toContain("reload");
    expect(output).toContain("logs");
    expect(output).toContain("保留用户数据");
  });

  it("documents managed source removal in top-level help", () => {
    const output = execFileSync(process.execPath, [cli, "--help"], { encoding: "utf8" });

    expect(output).toContain("uninstall");
    expect(output).toContain("卸载受管源码与全局命令并保留用户数据");
  });

  it("describes Setup by its model, provider, channel, and skill responsibilities", () => {
    const output = execFileSync(process.execPath, [cli, "--help"], { encoding: "utf8" });

    expect(output).toContain("配置 Provider、通讯渠道与项目技能");
  });

  it("explains the Setup categories in scoped help", () => {
    const output = execFileSync(process.execPath, [cli, "setup", "--help"], {
      encoding: "utf8",
    });

    expect(output).toContain("脱敏接入状态总览");
    expect(output).toContain("模型与提供商、通讯渠道和项目技能");
    expect(output).not.toContain("直接 API Provider");
  });


});
