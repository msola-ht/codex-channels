import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { cli, mkdtempSync, table, updateGatewayConfig } from "./codexc-cli-test-fixture.js";

const temporaryDirectories: string[] = [];

function authenticatedRemoteCodexHome(root: string): string {
  const codexHome = join(root, ".codex");
  mkdirSync(codexHome);
  writeFileSync(join(codexHome, "auth.json"), "{}\n");
  return codexHome;
}
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("codexc CLI", { timeout: 15_000 }, () => {
  if (process.platform === "win32") {
    it.skip("Windows 远程 TUI 使用 .cmd 包装器合同测试；Unix 可执行夹具不适用", () => undefined);
    return;
  }

  it("runs remote with the current or explicitly selected Workspace permissions", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-connect-cli-"));
    temporaryDirectories.push(root);
    const home = join(root, ".codex-connect");
    const first = join(root, "First Project");
    const second = join(root, "Second Project");
    const nestedWorkspace = join(first, "Nested Project");
    const nestedWorkdir = join(nestedWorkspace, "src");
    mkdirSync(first);
    mkdirSync(second);
    mkdirSync(nestedWorkdir, { recursive: true });
    const fakeCodex = join(root, "fake-codex.mjs");
    writeFileSync(
      fakeCodex,
      "#!/usr/bin/env node\nimport { writeFileSync } from 'node:fs';\nwriteFileSync(process.env.CODEX_TEST_CAPTURE, JSON.stringify(process.argv.slice(2)));\n",
    );
    chmodSync(fakeCodex, 0o700);
    const environment = {
      ...process.env,
      CODEX_HOME: authenticatedRemoteCodexHome(root),
      CODEX_CONNECT_HOME: home,
      CODEX_CONNECT_CONFIG_FILE: "",
    };
    execFileSync(process.execPath, [cli, "init"], { cwd: first, env: environment });
    execFileSync(process.execPath, [cli, "work", "add", "--cwd", first], { cwd: first, env: environment });
    const configPath = join(home, "config.toml");
    updateGatewayConfig(configPath, (document) => {
      table(document.codex).binary = fakeCodex;
    });
    execFileSync(process.execPath, [cli, "work", "add", "--cwd", second], { cwd: second, env: environment });
    execFileSync(process.execPath, [cli, "work", "add", "--cwd", nestedWorkspace], {
      cwd: nestedWorkspace,
      env: environment,
    });
    updateGatewayConfig(configPath, (document) => {
      const configuredWorkspaces = document.workspaces as Array<Record<string, unknown>>;
      const firstWorkspace = configuredWorkspaces.find(
        (candidate) => candidate.cwd === realpathSync(first),
      );
      const secondWorkspace = configuredWorkspaces.find(
        (candidate) => candidate.cwd === realpathSync(second),
      );
      const configuredNestedWorkspace = configuredWorkspaces.find(
        (candidate) => candidate.cwd === realpathSync(nestedWorkspace),
      );
      if (!firstWorkspace || !secondWorkspace || !configuredNestedWorkspace) {
        throw new Error("测试 Workspace 未注册");
      }
      firstWorkspace.permissions = ":workspace";
      firstWorkspace.approval_policy = "on-request";
      secondWorkspace.sandbox = "read-only";
      secondWorkspace.approval_policy = "never";
      configuredNestedWorkspace.sandbox = "danger-full-access";
      configuredNestedWorkspace.approval_policy = "on-request";
    });

    const currentCapture = join(root, "current.json");
    execFileSync(process.execPath, [cli, "remote", "resume"], {
      cwd: first,
      env: { ...environment, CODEX_TEST_CAPTURE: currentCapture },
    });
    const explicitCapture = join(root, "explicit.json");
    execFileSync(process.execPath, [cli, "remote", "--workspace", "second-project", "resume"], {
      cwd: first,
      env: { ...environment, CODEX_TEST_CAPTURE: explicitCapture },
    });
    const overriddenCapture = join(root, "overridden.json");
    execFileSync(process.execPath, [
      cli,
      "remote",
      "--sandbox",
      "danger-full-access",
      "--ask-for-approval",
      "on-request",
      "resume",
    ], {
      cwd: first,
      env: { ...environment, CODEX_TEST_CAPTURE: overriddenCapture },
    });
    const personalProfileCapture = join(root, "personal-profile.json");
    execFileSync(process.execPath, [cli, "remote", "--profile", "personal", "resume"], {
      cwd: first,
      env: { ...environment, CODEX_TEST_CAPTURE: personalProfileCapture },
    });
    const nestedCapture = join(root, "nested.json");
    execFileSync(process.execPath, [cli, "remote", "resume"], {
      cwd: nestedWorkdir,
      env: { ...environment, CODEX_TEST_CAPTURE: nestedCapture },
    });
    const workspaceWriteModifierCapture = join(root, "workspace-write-modifier.json");
    execFileSync(process.execPath, [
      cli,
      "remote",
      "--workspace",
      "second-project",
      "-c",
      "sandbox_workspace_write.network_access=true",
      "resume",
    ], {
      cwd: first,
      env: { ...environment, CODEX_TEST_CAPTURE: workspaceWriteModifierCapture },
    });

    expect(JSON.parse(readFileSync(currentCapture, "utf8"))).toEqual([
      "--remote",
      `unix://${join(home, "runtime", "codex-app-server.sock")}`,
      "-C",
      realpathSync(first),
      "-c",
      'default_permissions=":workspace"',
      "--ask-for-approval",
      "on-request",
      "resume",
    ]);
    expect(JSON.parse(readFileSync(explicitCapture, "utf8"))).toEqual([
      "--remote",
      `unix://${join(home, "runtime", "codex-app-server.sock")}`,
      "-C",
      realpathSync(second),
      "--sandbox",
      "read-only",
      "--ask-for-approval",
      "never",
      "resume",
    ]);
    expect(JSON.parse(readFileSync(overriddenCapture, "utf8"))).toEqual([
      "--remote",
      `unix://${join(home, "runtime", "codex-app-server.sock")}`,
      "-C",
      realpathSync(first),
      "--sandbox",
      "danger-full-access",
      "--ask-for-approval",
      "on-request",
      "resume",
    ]);
    expect(JSON.parse(readFileSync(personalProfileCapture, "utf8"))).toEqual([
      "--remote",
      `unix://${join(home, "runtime", "codex-app-server.sock")}`,
      "-C",
      realpathSync(first),
      "-c",
      'default_permissions=":workspace"',
      "--ask-for-approval",
      "on-request",
      "--profile",
      "personal",
      "resume",
    ]);
    expect(JSON.parse(readFileSync(nestedCapture, "utf8"))).toEqual([
      "--remote",
      `unix://${join(home, "runtime", "codex-app-server.sock")}`,
      "-C",
      realpathSync(nestedWorkdir),
      "--sandbox",
      "danger-full-access",
      "--ask-for-approval",
      "on-request",
      "resume",
    ]);
    expect(JSON.parse(readFileSync(workspaceWriteModifierCapture, "utf8"))).toEqual([
      "--remote",
      `unix://${join(home, "runtime", "codex-app-server.sock")}`,
      "-C",
      realpathSync(second),
      "--sandbox",
      "read-only",
      "--ask-for-approval",
      "never",
      "-c",
      "sandbox_workspace_write.network_access=true",
      "resume",
    ]);
  });

  it("fails closed when a remote Workspace uses the retired untrusted CLI policy", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-connect-remote-approval-"));
    temporaryDirectories.push(root);
    const home = join(root, ".codex-connect");
    const workspace = join(root, "Workspace");
    const capture = join(root, "capture.json");
    const fakeCodex = join(root, "fake-codex.mjs");
    mkdirSync(workspace);
    writeFileSync(
      fakeCodex,
      "#!/usr/bin/env node\nimport { writeFileSync } from 'node:fs';\nwriteFileSync(process.env.CODEX_TEST_CAPTURE, JSON.stringify(process.argv.slice(2)));\n",
    );
    chmodSync(fakeCodex, 0o700);
    const environment = {
      ...process.env,
      CODEX_CONNECT_HOME: home,
      CODEX_CONNECT_CONFIG_FILE: "",
      CODEX_TEST_CAPTURE: capture,
      CODEX_HOME: authenticatedRemoteCodexHome(root),
    };
    execFileSync(process.execPath, [cli, "init"], { cwd: workspace, env: environment });
    execFileSync(process.execPath, [cli, "work", "add", "--cwd", workspace], {
      cwd: workspace,
      env: environment,
    });
    updateGatewayConfig(join(home, "config.toml"), (document) => {
      table(document.codex).binary = fakeCodex;
      const configuredWorkspace = (document.workspaces as Array<Record<string, unknown>>).find(
        (candidate) => candidate.cwd === realpathSync(workspace),
      );
      if (!configuredWorkspace) throw new Error("测试 Workspace 未注册");
      configuredWorkspace.approval_policy = "untrusted";
    });

    const rejected = spawnSync(process.execPath, [cli, "remote"], {
      cwd: workspace,
      env: environment,
      encoding: "utf8",
    });

    expect(rejected.status).toBe(1);
    expect(rejected.stderr).toContain("Workspace 审批策略 untrusted 不能传给 Codex CLI 0.150.1");
    expect(existsSync(capture)).toBe(false);

    execFileSync(process.execPath, [
      cli,
      "remote",
      "--ask-for-approval",
      "on-request",
    ], { cwd: workspace, env: environment });
    expect(JSON.parse(readFileSync(capture, "utf8"))).toContain("on-request");
  });

  it("reports an invalid remote Workspace exactly once without a Node stack", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-connect-remote-error-"));
    temporaryDirectories.push(root);
    const home = join(root, ".codex-connect");
    const workspace = join(root, "Workspace");
    mkdirSync(workspace);
    const environment = {
      ...process.env,
      CODEX_HOME: authenticatedRemoteCodexHome(root),
      CODEX_CONNECT_HOME: home,
      CODEX_CONNECT_CONFIG_FILE: "",
    };
    execFileSync(process.execPath, [cli, "init"], { cwd: workspace, env: environment });

    const result = spawnSync(
      process.execPath,
      [cli, "remote", "--workspace", "missing-workspace"],
      { cwd: workspace, env: environment, encoding: "utf8" },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("找不到 Workspace：missing-workspace");
    expect(result.stderr.match(/\[失败\]/g)).toHaveLength(1);
    expect(result.stderr).not.toContain("子命令执行失败");
    expect(result.stderr).not.toContain("Node.js v");
    expect(result.stderr).not.toContain("file://");
  });

  it("propagates the signal that terminates the remote Codex process", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-connect-remote-signal-"));
    temporaryDirectories.push(root);
    const home = join(root, ".codex-connect");
    const workspace = join(root, "Workspace");
    const fakeCodex = join(root, "fake-codex.mjs");
    mkdirSync(workspace);
    writeFileSync(
      fakeCodex,
      "#!/usr/bin/env node\nprocess.kill(process.pid, 'SIGTERM');\n",
    );
    chmodSync(fakeCodex, 0o700);
    const environment = {
      ...process.env,
      CODEX_HOME: authenticatedRemoteCodexHome(root),
      CODEX_CONNECT_HOME: home,
      CODEX_CONNECT_CONFIG_FILE: "",
    };
    execFileSync(process.execPath, [cli, "init"], { cwd: workspace, env: environment });
    updateGatewayConfig(join(home, "config.toml"), (document) => {
      table(document.codex).binary = fakeCodex;
    });

    const result = spawnSync(process.execPath, [cli, "remote"], {
      cwd: workspace,
      env: environment,
      encoding: "utf8",
    });

    expect(result.status).toBeNull();
    expect(result.signal).toBe("SIGTERM");
    expect(result.stderr).toBe("");
  });

  it("reports a silent non-zero remote Codex exit exactly once", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-connect-remote-exit-"));
    temporaryDirectories.push(root);
    const home = join(root, ".codex-connect");
    const workspace = join(root, "Workspace");
    const fakeCodex = join(root, "fake-codex.mjs");
    mkdirSync(workspace);
    writeFileSync(fakeCodex, "#!/usr/bin/env node\nprocess.exit(7);\n");
    chmodSync(fakeCodex, 0o700);
    const environment = {
      ...process.env,
      CODEX_HOME: authenticatedRemoteCodexHome(root),
      CODEX_CONNECT_HOME: home,
      CODEX_CONNECT_CONFIG_FILE: "",
    };
    execFileSync(process.execPath, [cli, "init"], { cwd: workspace, env: environment });
    updateGatewayConfig(join(home, "config.toml"), (document) => {
      table(document.codex).binary = fakeCodex;
    });

    const result = spawnSync(process.execPath, [cli, "remote"], {
      cwd: workspace,
      env: environment,
      encoding: "utf8",
    });

    expect(result.status).toBe(7);
    expect(result.stderr).toContain("Codex TUI 已退出：exit=7");
    expect(result.stderr.match(/\[失败\]/g)).toHaveLength(1);
    expect(result.stderr).not.toContain("子命令执行失败");
  });


});
