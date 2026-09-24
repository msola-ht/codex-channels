import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { AppServerSupervisorOwner } from "../runtime/app-server-supervisor.mjs";
import {
  deepseekAccountDefinition
} from "../runtime/model-provider-definitions.mjs";
import { writeCustomPrimaryProviderSwitchingProfile } from "../runtime/model-provider-runtime.mjs";
import {
  cli,
  execFileAsync,
  mkdtempSync,
  table,
  unixSocketTmpdir,
  updateGatewayConfig,
  writeManagedProviderFixture,
} from "./codexc-cli-test-fixture.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("codexc CLI", { timeout: 15_000 }, () => {
  if (process.platform === "win32") {
    it.skip("Windows 远程 Profile 使用服务合同测试；Unix 可执行夹具不适用", () => undefined);
    return;
  }

  it("routes the DeepSeek profile to its isolated remote App Server and authenticates the TUI", async () => {
    const root = mkdtempSync(join(unixSocketTmpdir, "codex-connect-remote-profile-"));
    temporaryDirectories.push(root);
    const home = join(root, ".codex-connect");
    const codexHome = join(root, ".codex");
    const workspace = join(root, "Workspace");
    mkdirSync(workspace);
    mkdirSync(codexHome);
    const fakeCodex = join(root, "fake-codex.mjs");
    writeFileSync(
      fakeCodex,
      "#!/usr/bin/env node\nimport { writeFileSync } from 'node:fs';\nwriteFileSync(process.env.CODEX_TEST_CAPTURE, JSON.stringify(process.argv.slice(2)));\n",
    );
    chmodSync(fakeCodex, 0o700);
    writeManagedProviderFixture(
      codexHome,
      home,
      deepseekAccountDefinition("test"),
      "switching",
      "sk-test-secret",
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

    const primarySocketPath = join(home, "runtime", "codex-app-server.sock");
    const supervisor = new AppServerSupervisorOwner(primarySocketPath, {
      primaryProvider: "openai",
      managedProviders: ["ds-test"],
      socketPaths: [
        primarySocketPath,
        join(home, "runtime", "codex-app-server-ds-test.sock"),
      ],
    }, { ensureProvider: async () => undefined });
    await supervisor.start();
    try {
      for (const [index, args] of [
        ["--profile", "sf-ds-test"],
        ["--profile=sf-ds-test"],
        ["-p", "sf-ds-test"],
        ["-p=sf-ds-test"],
        ["-psf-ds-test"],
      ].entries()) {
        const capturePath = join(root, `capture-${index}.json`);
        await execFileAsync(process.execPath, [cli, "remote", ...args, "resume"], {
          cwd: workspace,
          env: { ...environment, CODEX_TEST_CAPTURE: capturePath },
          encoding: "utf8",
        });

        expect(JSON.parse(readFileSync(capturePath, "utf8"))).toEqual([
          "--remote",
          `unix://${join(home, "runtime", "codex-app-server-ds-test.sock")}`,
          "-C",
          realpathSync(workspace),
          "--profile",
          "sf-ds-test",
          "resume",
        ]);
      }
      const passthroughCapture = join(root, "capture-passthrough.json");
      await execFileAsync(
        process.execPath,
        [cli, "remote", "resume", "--", "--profile", "ds-test", "--workspace", "external"],
        {
          cwd: workspace,
          env: { ...environment, CODEX_TEST_CAPTURE: passthroughCapture },
          encoding: "utf8",
        },
      );
      expect(JSON.parse(readFileSync(passthroughCapture, "utf8"))).toEqual([
        "--remote",
        `unix://${join(home, "runtime", "codex-app-server-ds-test.sock")}`,
        "-C",
        realpathSync(workspace),
        "--profile",
        "sf-ds-test",
        "resume",
        "--",
        "--profile",
        "ds-test",
        "--workspace",
        "external",
      ]);
    } finally {
      await supervisor.close();
    }
  }, 30_000);

  it("uses the native custom Profile without dropping the current Workspace permissions", async () => {
    const root = mkdtempSync(join(unixSocketTmpdir, "codex-connect-remote-custom-profile-"));
    temporaryDirectories.push(root);
    const home = join(root, ".codex-connect");
    const codexHome = join(root, ".codex");
    const workspace = join(root, "Workspace");
    mkdirSync(workspace);
    mkdirSync(codexHome);
    const fakeCodex = join(root, "fake-codex.mjs");
    writeFileSync(
      fakeCodex,
      "#!/usr/bin/env node\nimport { writeFileSync } from 'node:fs';\nwriteFileSync(process.env.CODEX_TEST_CAPTURE, JSON.stringify(process.argv.slice(2)));\n",
    );
    chmodSync(fakeCodex, 0o700);
    const environment = {
      ...process.env,
      CODEX_CONNECT_HOME: home,
      CODEX_CONNECT_CONFIG_FILE: "",
      CODEX_HOME: codexHome,
    };
    execFileSync(process.execPath, [cli, "init"], { cwd: workspace, env: environment });
    execFileSync(process.execPath, [cli, "work", "add", "--cwd", workspace], {
      cwd: workspace,
      env: environment,
    });
    writeFileSync(join(codexHome, "config.toml"), 'model_provider = "openai"\n', { mode: 0o600 });
    writeCustomPrimaryProviderSwitchingProfile({
      provider: "codeproxy-dev",
      model: "gpt-5.6-sol",
      name: "CodeProxy Dev",
      baseUrl: "https://proxy.example.test/v1",
      apiKey: "sk-test-secret",
    }, environment);
    updateGatewayConfig(join(home, "config.toml"), (document) => {
      table(document.codex).binary = fakeCodex;
      const configuredWorkspace = (document.workspaces as Array<Record<string, unknown>>)
        .find((candidate) => candidate.cwd === realpathSync(workspace));
      if (!configuredWorkspace) throw new Error("测试 Workspace 未注册");
      configuredWorkspace.sandbox = "read-only";
      configuredWorkspace.approval_policy = "never";
    });

    const primarySocketPath = join(home, "runtime", "codex-app-server.sock");
    const customSocketPath = join(home, "runtime", "codex-app-server-codeproxy-dev.sock");
    const supervisor = new AppServerSupervisorOwner(primarySocketPath, {
      primaryProvider: "openai",
      managedProviders: ["codeproxy-dev"],
      socketPaths: [primarySocketPath, customSocketPath],
    }, { ensureProvider: async () => undefined });
    await supervisor.start();
    try {
      const capturePath = join(root, "capture.json");
      await execFileAsync(
        process.execPath,
        [cli, "remote", "--profile", "sf-custom-codeproxy-dev", "resume"],
        {
          cwd: workspace,
          env: { ...environment, CODEX_TEST_CAPTURE: capturePath },
          encoding: "utf8",
        },
      );

      expect(JSON.parse(readFileSync(capturePath, "utf8"))).toEqual([
        "--remote",
        `unix://${customSocketPath}`,
        "-C",
        realpathSync(workspace),
        "--profile",
        "sf-custom-codeproxy-dev",
        "--sandbox",
        "read-only",
        "--ask-for-approval",
        "never",
        "resume",
      ]);
    } finally {
      await supervisor.close();
    }

    const oldProfile = spawnSync(
      process.execPath,
      [cli, "remote", "--profile", "custom-codeproxy-dev"],
      { cwd: workspace, env: environment, encoding: "utf8" },
    );
    expect(oldProfile.status).toBe(1);
    expect(oldProfile.stderr).toContain(
      "Profile custom-codeproxy-dev 不是该 Provider 的规范名称；请使用 --profile sf-custom-codeproxy-dev",
    );

    const providerId = spawnSync(
      process.execPath,
      [cli, "remote", "--profile", "codeproxy-dev"],
      { cwd: workspace, env: environment, encoding: "utf8" },
    );
    expect(providerId.status).toBe(1);
    expect(providerId.stderr).toContain(
      "codeproxy-dev 是 Provider ID；请使用 --profile sf-custom-codeproxy-dev",
    );
  }, 30_000);


});
