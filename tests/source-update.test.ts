import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  getCodexVersionMismatchRemediation,
  getSourceUpdateFailure,
  inspectManagedSourceUpdatePlan,
  managedSourceCheckout,
  updateManagedSourceInstallation,
  writeSourceUpdateFailure,
} from "../scripts/source-update.mjs";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Git 源码更新", () => {
  it("returns a redacted revisioned plan before changing a managed checkout", () => {
    const fixture = createInstalledFixture("codexc-source-update-plan-");

    const plan = inspectManagedSourceUpdatePlan(fixture.environment, {
      projectDir: fixture.checkout,
      repository: fixture.repository,
    });

    expect(plan).toMatchObject({
      operation: "source-update",
      managed: true,
      checkout: fixture.checkout,
      currentCommit: fixture.initialCommit,
      currentVersion: "0.147.0",
      targetCommit: fixture.latestCommit,
      updateAvailable: true,
      refreshCommand: false,
      steps: [
        "inspect",
        "clone-candidate",
        "validate-candidate",
        "build-candidate",
        "inspect-candidate",
        "prepare-codex-cli",
        "validate-codex-contract",
        "stop-services",
        "switch-source",
        "refresh-command",
        "local-update",
        "cleanup",
      ],
    });
    expect(plan.revision).toMatch(/^[0-9a-f]{64}$/u);
    expect(JSON.stringify(plan)).not.toContain(fixture.repository);
  });

  it("rejects a stale plan before cloning or stopping services", async () => {
    const fixture = createInstalledFixture("codexc-source-update-stale-plan-");
    const plan = inspectManagedSourceUpdatePlan(fixture.environment, {
      projectDir: fixture.checkout,
      repository: fixture.repository,
    });
    writeFileSync(join(fixture.repository, "later.txt"), "later");
    runGit(fixture.repository, ["add", "."]);
    runGit(fixture.repository, ["commit", "--quiet", "-m", "later"]);
    let cloned = false;
    let stopped = false;

    await expect(updateManagedSourceInstallation(fixture.environment, {
      expectedRevision: plan.revision,
      projectDir: fixture.checkout,
      repository: fixture.repository,
      runCommand: () => { cloned = true; },
      stopServices: () => { stopped = true; },
    })).rejects.toThrow("源码更新预检状态已变化");

    expect(cloned).toBe(false);
    expect(stopped).toBe(false);
  });

  it("does not echo credentials from a mismatched repository origin", () => {
    const fixture = createInstalledFixture("codexc-source-update-origin-");
    let failure: unknown;

    try {
      inspectManagedSourceUpdatePlan(fixture.environment, {
        projectDir: fixture.checkout,
        repository: "https://user:secret@example.invalid/private.git",
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("已配置其他地址");
    expect((failure as Error).message).not.toContain("secret");
    expect((failure as Error).message).not.toContain(fixture.repository);
  });

  it("reports prepared state and ordered progress without trusting observers", async () => {
    const fixture = createInstalledFixture("codexc-source-update-progress-");
    const progress: string[] = [];
    let prepared: unknown;

    const result = await updateManagedSourceInstallation(fixture.environment, {
      buildCheckout: () => undefined,
      inspectStaged: async () => ({ services: { installed: false } }),
      installGlobalPackage: () => undefined,
      onPrepared: (value) => { prepared = value; },
      onProgress: (event) => {
        progress.push(`${event.stage}:${event.status}`);
        if (event.stage === "inspect" && event.status === "started") {
          throw new Error("observer failed");
        }
      },
      projectDir: fixture.checkout,
      repository: fixture.repository,
      runLocalUpdate: () => undefined,
    });

    expect(result.changed).toBe(true);
    expect(prepared).toMatchObject({
      operation: "source-update",
      services: { installed: false },
      requiresServiceInterruption: false,
      targetVersion: "0.147.0",
    });
    expect((prepared as { steps: string[] }).steps).not.toContain("stop-services");
    expect(progress).toEqual([
      "inspect:started",
      "inspect:completed",
      "clone-candidate:started",
      "clone-candidate:completed",
      "validate-candidate:started",
      "validate-candidate:completed",
      "build-candidate:started",
      "build-candidate:completed",
      "inspect-candidate:started",
      "inspect-candidate:completed",
      "prepare-codex-cli:started",
      "prepare-codex-cli:completed",
      "validate-codex-contract:started",
      "validate-codex-contract:completed",
      "switch-source:started",
      "switch-source:completed",
      "refresh-command:started",
      "refresh-command:completed",
      "local-update:started",
      "local-update:completed",
      "cleanup:started",
      "cleanup:completed",
    ]);
  });

  it("updates to a newer main commit without requiring a version change", async () => {
    const fixture = createInstalledFixture("codexc-source-update-");
    let globalInstalls = 0;
    let localUpdateCheckout = "";
    const messages: Array<[string, string]> = [];

    expect(managedSourceCheckout(fixture.environment, fixture.checkout))
      .toBe(fixture.checkout);
    const result = await updateManagedSourceInstallation(fixture.environment, {
      buildCheckout: (candidate) => {
        mkdirSync(join(candidate, "dist"), { recursive: true });
        mkdirSync(join(candidate, "webui", "dist"), { recursive: true });
        writeFileSync(join(candidate, "dist", "main.js"), "");
        writeFileSync(join(candidate, "webui", "dist", "index.html"), "");
      },
      inspectStaged: async () => ({ services: { installed: false } }),
      installGlobalPackage: () => { globalInstalls += 1; },
      projectDir: fixture.checkout,
      repository: fixture.repository,
      runLocalUpdate: (candidate) => {
        localUpdateCheckout = candidate;
      },
      writeMessage: (kind, message) => { messages.push([kind, message]); },
    });

    expect(result).toEqual({
      changed: true,
      commit: fixture.latestCommit,
      managed: true,
      previousVersion: "0.147.0",
      version: "0.147.0",
    });
    expect(localUpdateCheckout).toBe(fixture.checkout);
    expect(readFileSync(join(fixture.checkout, "fix.txt"), "utf8")).toBe("fixed");
    expect(globalInstalls).toBe(1);
    expect(existsSync(fixture.legacyLauncher)).toBe(false);
    expect(existsSync(fixture.hiddenLauncher)).toBe(false);
    expect(readFileSync(fixture.profile, "utf8")).toBe("");
    expect(gitOutput(fixture.checkout, [
      "config",
      "--local",
      "--get",
      "codex-connect.managed-source",
    ])).toBe("true");
    expect(readdirSync(fixture.installRoot).filter((name) => name.includes("pre-update")))
      .toEqual([]);
    expect(messages).toEqual([
      [
        "note",
        `Git 源码检查：当前 ${fixture.initialCommit.slice(0, 12)} · main ${fixture.latestCommit.slice(0, 12)}`,
      ],
      ["note", "正在克隆 Git main 候选源码。"],
      ["note", "正在构建并预检候选源码；详细日志仅在失败时显示。"],
      ["note", "正在核对候选版本的 Codex 公开合同。"],
      ["note", "候选源码已通过校验，准备切换。"],
      ["note", "源码命令已刷新到 npm 全局安装，并清理旧 PATH 入口。"],
    ]);
  });

  it("updates a stable source checkout to a Gateway fix release", async () => {
    const fixture = createInstalledFixture("codexc-source-update-fix-release-");
    writePackageVersion(fixture.repository, "0.147.0-fix1");
    runGit(fixture.repository, ["add", "."]);
    runGit(fixture.repository, ["commit", "--quiet", "-m", "fix release"]);

    const result = await updateManagedSourceInstallation(fixture.environment, {
      buildCheckout: () => undefined,
      inspectStaged: async () => ({ services: { installed: false } }),
      installGlobalPackage: () => undefined,
      projectDir: fixture.checkout,
      repository: fixture.repository,
      runLocalUpdate: () => undefined,
    });

    expect(result).toMatchObject({
      changed: true,
      previousVersion: "0.147.0",
      version: "0.147.0-fix1",
    });
    expect(JSON.parse(readFileSync(join(fixture.checkout, "package.json"), "utf8")).version)
      .toBe("0.147.0-fix1");
  });

  it("updates an older stable source checkout to a newer Gateway rc release", async () => {
    const fixture = createInstalledFixture("codexc-source-update-rc-release-");
    writePackageVersion(fixture.repository, "0.148.0-rc.1");
    runGit(fixture.repository, ["add", "."]);
    runGit(fixture.repository, ["commit", "--quiet", "-m", "rc release"]);
    writeFileSync(fixture.codex, "#!/bin/sh\nprintf '%s\\n' 'codex-cli 0.148.0'\n");

    const result = await updateManagedSourceInstallation(fixture.environment, {
      buildCheckout: () => undefined,
      inspectStaged: async () => ({ services: { installed: false } }),
      installGlobalPackage: () => undefined,
      projectDir: fixture.checkout,
      repository: fixture.repository,
      runLocalUpdate: () => undefined,
    });

    expect(result).toMatchObject({
      changed: true,
      previousVersion: "0.147.0",
      version: "0.148.0-rc.1",
    });
    expect(JSON.parse(readFileSync(join(fixture.checkout, "package.json"), "utf8")).version)
      .toBe("0.148.0-rc.1");
  });

  it("updates an rc source checkout to the same base stable version", async () => {
    const fixture = createInstalledFixture("codexc-source-update-rc-to-stable-");
    writePackageVersion(fixture.repository, "0.148.0-rc.1");
    runGit(fixture.repository, ["add", "."]);
    runGit(fixture.repository, ["commit", "--quiet", "-m", "rc release"]);
    const rcCommit = gitOutput(fixture.repository, ["rev-parse", "HEAD"]);
    writePackageVersion(fixture.repository, "0.148.0");
    runGit(fixture.repository, ["add", "."]);
    runGit(fixture.repository, ["commit", "--quiet", "-m", "restore stable base"]);
    runGit(fixture.checkout, ["fetch", "--quiet", "origin"]);
    runGit(fixture.checkout, ["reset", "--quiet", "--hard", rcCommit]);
    writeFileSync(fixture.codex, "#!/bin/sh\nprintf '%s\\n' 'codex-cli 0.148.0'\n");

    const result = await updateManagedSourceInstallation(fixture.environment, {
      buildCheckout: () => undefined,
      inspectStaged: async () => ({ services: { installed: false } }),
      installGlobalPackage: () => undefined,
      projectDir: fixture.checkout,
      repository: fixture.repository,
      runLocalUpdate: () => undefined,
    });

    expect(result).toMatchObject({
      changed: true,
      previousVersion: "0.148.0-rc.1",
      version: "0.148.0",
    });
  });

  it("migrates the legacy launcher even when main is already current", async () => {
    const fixture = createInstalledFixture("codexc-source-launcher-migration-");
    runGit(fixture.checkout, ["reset", "--quiet", "--hard", fixture.latestCommit]);
    let globalInstalls = 0;
    const messages: Array<[string, string]> = [];
    const plan = inspectManagedSourceUpdatePlan(fixture.environment, {
      projectDir: fixture.checkout,
      repository: fixture.repository,
    });

    expect(plan).toMatchObject({
      managed: true,
      updateAvailable: false,
      refreshCommand: true,
      steps: ["inspect", "validate-codex-contract", "refresh-command"],
    });

    const result = await updateManagedSourceInstallation(fixture.environment, {
      buildCheckout: () => { throw new Error("不应重新构建"); },
      installGlobalPackage: () => { globalInstalls += 1; },
      projectDir: fixture.checkout,
      repository: fixture.repository,
      writeMessage: (kind, message) => { messages.push([kind, message]); },
    });

    expect(result).toEqual({
      changed: false,
      commit: fixture.latestCommit,
      managed: true,
      version: "0.147.0",
    });
    expect(globalInstalls).toBe(1);
    expect(existsSync(fixture.legacyLauncher)).toBe(false);
    expect(existsSync(fixture.hiddenLauncher)).toBe(false);
    expect(messages).toContainEqual([
      "note",
      "源码命令已刷新到 npm 全局安装，并清理旧 PATH 入口。",
    ]);
  });

  it("recognizes a globally installed command through the managed Git marker", () => {
    const fixture = createInstalledFixture("codexc-source-global-marker-");
    const globalPackage = join(fixture.installRoot, "npm-global-package");
    mkdirSync(globalPackage);
    runGit(fixture.checkout, ["config", "--local", "codex-connect.managed-source", "true"]);

    expect(managedSourceCheckout(fixture.environment, globalPackage)).toBe(fixture.checkout);
  });

  it("refuses an unrelated legacy command before replacing the global package", async () => {
    const fixture = createInstalledFixture("codexc-source-unrelated-launcher-");
    runGit(fixture.checkout, ["reset", "--quiet", "--hard", fixture.latestCommit]);
    writeFileSync(fixture.legacyLauncher, "#!/bin/sh\nexec unrelated-command\n");
    let globalInstalls = 0;

    await expect(updateManagedSourceInstallation(fixture.environment, {
      installGlobalPackage: () => { globalInstalls += 1; },
      projectDir: fixture.checkout,
      repository: fixture.repository,
    })).rejects.toThrow("旧命令入口不属于受管源码安装");

    expect(globalInstalls).toBe(0);
    expect(existsSync(fixture.legacyLauncher)).toBe(true);
  });

  it("restores the old checkout and services when switching the candidate fails", async () => {
    const fixture = createInstalledFixture("codexc-source-switch-failure-");
    let renameCalls = 0;
    let stopCalls = 0;
    let startCalls = 0;

    await expect(updateManagedSourceInstallation(fixture.environment, {
      buildCheckout: () => undefined,
      inspectStaged: async () => ({ services: { installed: true } }),
      projectDir: fixture.checkout,
      repository: fixture.repository,
      renamePath: (oldPath, newPath) => {
        renameCalls += 1;
        if (renameCalls === 2) throw new Error("candidate switch failed");
        renameSync(oldPath, newPath);
      },
      startServices: () => { startCalls += 1; },
      stopServices: () => { stopCalls += 1; },
    })).rejects.toThrow("candidate switch failed");

    expect(stopCalls).toBe(1);
    expect(startCalls).toBe(1);
    expect(JSON.parse(readFileSync(join(fixture.checkout, "package.json"), "utf8")).version)
      .toBe("0.147.0");
  });

  it("restores services when stopping them fails before switching source", async () => {
    const fixture = createInstalledFixture("codexc-source-stop-failure-");
    let startCalls = 0;

    await expect(updateManagedSourceInstallation(fixture.environment, {
      buildCheckout: () => undefined,
      inspectStaged: async () => ({ services: { installed: true } }),
      projectDir: fixture.checkout,
      repository: fixture.repository,
      startServices: () => { startCalls += 1; },
      stopServices: () => { throw new Error("stop failed"); },
    })).rejects.toThrow("stop failed");

    expect(startCalls).toBe(1);
    expect(JSON.parse(readFileSync(join(fixture.checkout, "package.json"), "utf8")).version)
      .toBe("0.147.0");
  });

  it("reports both failures when stopping and restoring services fail before switching source", async () => {
    const fixture = createInstalledFixture("codexc-source-stop-and-restore-failure-");
    let failure: unknown;

    try {
      await updateManagedSourceInstallation(fixture.environment, {
        buildCheckout: () => undefined,
        inspectStaged: async () => ({ services: { installed: true } }),
        projectDir: fixture.checkout,
        repository: fixture.repository,
        startServices: () => { throw new Error("start failed"); },
        stopServices: () => { throw new Error("stop failed"); },
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).message)
      .toBe("源码更新失败，且原核心服务未能恢复运行");
    expect((failure as AggregateError).errors.map((error) => (error as Error).message))
      .toEqual(["stop failed", "start failed"]);
  });

  it("restores services when the global command refresh fails after switching source", async () => {
    const fixture = createInstalledFixture("codexc-source-global-install-failure-");
    let startCalls = 0;
    let localUpdateCalls = 0;

    let failure: unknown;
    try {
      await updateManagedSourceInstallation(fixture.environment, {
        buildCheckout: () => undefined,
        inspectStaged: async () => ({ services: { installed: true } }),
        installGlobalPackage: () => { throw new Error("global install failed"); },
        projectDir: fixture.checkout,
        repository: fixture.repository,
        runLocalUpdate: () => { localUpdateCalls += 1; },
        startServices: () => { startCalls += 1; },
        stopServices: () => undefined,
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("main 源码已切换，但本地更新未完成");
    expect(getSourceUpdateFailure(failure)).toMatchObject({
      operation: "source-update",
      code: "source-update-failed",
      stage: "refresh-command",
      completedStages: expect.arrayContaining([
        "inspect",
        "clone-candidate",
        "validate-candidate",
        "build-candidate",
        "inspect-candidate",
        "prepare-codex-cli",
        "stop-services",
        "switch-source",
      ]),
      recovery: {
        services: "restored",
        source: "switched-backup-retained",
        backupPath: expect.stringContaining("pre-update"),
      },
    });
    expect(startCalls).toBe(1);
    expect(localUpdateCalls).toBe(0);
    expect(readFileSync(join(fixture.checkout, "fix.txt"), "utf8")).toBe("fixed");
    expect(readdirSync(fixture.installRoot).some((name) => name.includes("pre-update")))
      .toBe(true);
  });

  it("reports both failures when services cannot recover after switching source", async () => {
    const fixture = createInstalledFixture("codexc-source-global-install-start-failure-");
    let failure: unknown;

    try {
      await updateManagedSourceInstallation(fixture.environment, {
        buildCheckout: () => undefined,
        inspectStaged: async () => ({ services: { installed: true } }),
        installGlobalPackage: () => { throw new Error("global install failed"); },
        projectDir: fixture.checkout,
        repository: fixture.repository,
        startServices: () => { throw new Error("service start failed"); },
        stopServices: () => undefined,
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).message)
      .toBe("源码已切换但本地更新失败，且核心服务未能恢复运行");
    expect((failure as AggregateError).errors.map((error) => (error as Error).message))
      .toEqual([
        expect.stringContaining("main 源码已切换，但本地更新未完成"),
        "service start failed",
      ]);
  });

  it("rejects a dirty checkout before resolving or stopping anything", async () => {
    const fixture = createInstalledFixture("codexc-source-dirty-");
    writeFileSync(join(fixture.checkout, "local-change.txt"), "dirty");
    let servicesStopped = false;

    await expect(updateManagedSourceInstallation(fixture.environment, {
      projectDir: fixture.checkout,
      repository: fixture.repository,
      stopServices: () => { servicesStopped = true; },
    })).rejects.toThrow("存在未提交修改");

    expect(servicesStopped).toBe(false);
  });

  it("rejects a version mismatch without an interactive confirmation", async () => {
    const fixture = createInstalledFixture("codexc-source-version-mismatch-");
    writePackageVersion(fixture.repository, "0.148.0");
    runGit(fixture.repository, ["add", "."]);
    runGit(fixture.repository, ["commit", "--quiet", "-m", "upgrade"]);
    let candidateBuilt = false;
    let servicesStopped = false;

    let failure: unknown;
    try {
      await updateManagedSourceInstallation(fixture.environment, {
        buildCheckout: () => { candidateBuilt = true; },
        projectDir: fixture.checkout,
        repository: fixture.repository,
        stopServices: () => { servicesStopped = true; },
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message)
      .toBe("Codex CLI 版本不匹配：需要 0.148.0，当前 0.147.0");
    expect(getCodexVersionMismatchRemediation(failure)).toEqual([
      "npm install -g @openai/codex@0.148.0",
      "安装完成后重新运行 codexc update",
    ]);
    const messages: Array<{ kind: string; message: string }> = [];
    writeSourceUpdateFailure(failure, (kind, message) => {
      messages.push({ kind, message });
    });
    expect(messages).toEqual([
      {
        kind: "failure",
        message: "Codex CLI 版本不匹配：需要 0.148.0，当前 0.147.0",
      },
      {
        kind: "remediation",
        message: "npm install -g @openai/codex@0.148.0",
      },
      {
        kind: "remediation",
        message: "安装完成后重新运行 codexc update",
      },
    ]);

    expect(candidateBuilt).toBe(false);
    expect(servicesStopped).toBe(false);
    expect(JSON.parse(readFileSync(join(fixture.checkout, "package.json"), "utf8")).version)
      .toBe("0.147.0");
  });

  it("does not install or change source when the Codex CLI installation is declined", async () => {
    const fixture = createInstalledFixture("codexc-source-version-decline-");
    writePackageVersion(fixture.repository, "0.148.0");
    runGit(fixture.repository, ["add", "."]);
    runGit(fixture.repository, ["commit", "--quiet", "-m", "upgrade"]);
    let installed = false;
    let servicesStopped = false;

    await expect(updateManagedSourceInstallation(fixture.environment, {
      buildCheckout: () => undefined,
      confirmCodexCliInstall: () => false,
      inspectStaged: async () => ({ services: { installed: true } }),
      installCodexCli: () => { installed = true; },
      projectDir: fixture.checkout,
      repository: fixture.repository,
      stopServices: () => { servicesStopped = true; },
    })).rejects.toThrow("Codex CLI 版本不匹配：需要 0.148.0，当前 0.147.0");

    expect(installed).toBe(false);
    expect(servicesStopped).toBe(false);
    expect(JSON.parse(readFileSync(join(fixture.checkout, "package.json"), "utf8")).version)
      .toBe("0.147.0");
  });

  it("installs the confirmed Codex CLI version before continuing the source update", async () => {
    const fixture = createInstalledFixture("codexc-source-version-install-");
    writePackageVersion(fixture.repository, "0.148.0");
    runGit(fixture.repository, ["add", "."]);
    runGit(fixture.repository, ["commit", "--quiet", "-m", "upgrade"]);
    const confirmations: unknown[] = [];
    const installedVersions: string[] = [];
    const messages: Array<[string, string]> = [];

    const result = await updateManagedSourceInstallation(fixture.environment, {
      buildCheckout: () => undefined,
      confirmCodexCliInstall: (request) => {
        confirmations.push(request);
        return true;
      },
      inspectStaged: async () => ({ services: { installed: false } }),
      installGlobalPackage: () => undefined,
      projectDir: fixture.checkout,
      repository: fixture.repository,
      runCommand: (command, args, options) => {
        if (
          (command === "npm" || command === "npm.cmd")
          && args[0] === "install"
          && args[1] === "-g"
          && args[2]?.startsWith("@openai/codex@")
        ) {
          const version = args[2].slice("@openai/codex@".length);
          installedVersions.push(version);
          writeFileSync(
            fixture.codex,
            `#!/bin/sh\nprintf '%s\\n' 'codex-cli ${version}'\n`,
          );
          chmodSync(fixture.codex, 0o755);
          return;
        }
        execFileSync(command, args, {
          cwd: options.cwd as string,
          env: options.environment as NodeJS.ProcessEnv,
          stdio: "ignore",
        });
      },
      runLocalUpdate: () => undefined,
      writeMessage: (kind, message) => { messages.push([kind, message]); },
    });

    expect(confirmations).toEqual([{
      currentVersion: "0.147.0",
      requiredVersion: "0.148.0",
    }]);
    expect(installedVersions).toEqual(["0.148.0"]);
    expect(messages).toContainEqual([
      "note",
      "正在全局安装 @openai/codex@0.148.0。",
    ]);
    expect(messages).toContainEqual([
      "success",
      "Codex CLI 0.148.0 已安装，继续源码更新。",
    ]);
    expect(result).toMatchObject({
      changed: true,
      previousVersion: "0.147.0",
      version: "0.148.0",
    });
  });

  it("keeps the current source and services when the candidate Codex contract needs adaptation", async () => {
    const fixture = createInstalledFixture("codexc-source-contract-mismatch-");
    let servicesStopped = false;
    let globalInstalled = false;

    let failure: unknown;
    try {
      await updateManagedSourceInstallation(fixture.environment, {
        buildCheckout: () => undefined,
        inspectStaged: async () => ({ services: { installed: true } }),
        installGlobalPackage: () => { globalInstalled = true; },
        projectDir: fixture.checkout,
        repository: fixture.repository,
        runLocalUpdate: () => undefined,
        stopServices: () => { servicesStopped = true; },
        validateCodexContract: () => {
          throw new Error("公开参数 --ask-for-approval 删除值：on-request");
        },
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("--ask-for-approval 删除值");
    expect(getSourceUpdateFailure(failure)).toMatchObject({
      stage: "validate-codex-contract",
      recovery: { services: "not-needed", source: "unchanged" },
    });
    expect(servicesStopped).toBe(false);
    expect(globalInstalled).toBe(false);
    expect(gitOutput(fixture.checkout, ["rev-parse", "HEAD"]))
      .toBe(fixture.initialCommit);
  });

  it("keeps the current source and services when Codex CLI installation fails", async () => {
    const fixture = createInstalledFixture("codexc-source-version-install-failure-");
    writePackageVersion(fixture.repository, "0.148.0");
    runGit(fixture.repository, ["add", "."]);
    runGit(fixture.repository, ["commit", "--quiet", "-m", "upgrade"]);
    let candidateBuilt = false;
    let servicesStopped = false;

    let failure: unknown;
    try {
      await updateManagedSourceInstallation(fixture.environment, {
        buildCheckout: () => { candidateBuilt = true; },
        confirmCodexCliInstall: () => true,
        inspectStaged: async () => ({ services: { installed: true } }),
        installCodexCli: () => { throw new Error("npm install failed"); },
        projectDir: fixture.checkout,
        repository: fixture.repository,
        stopServices: () => { servicesStopped = true; },
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message)
      .toBe("Codex CLI 0.148.0 安装失败：npm install failed");
    expect(getCodexVersionMismatchRemediation(failure)).toEqual([
      "npm install -g @openai/codex@0.148.0",
      "安装完成后重新运行 codexc update",
    ]);
    expect(candidateBuilt).toBe(true);
    expect(servicesStopped).toBe(false);
    expect(JSON.parse(readFileSync(join(fixture.checkout, "package.json"), "utf8")).version)
      .toBe("0.147.0");
  });

  it("rejects a clean checkout with custom commits", async () => {
    const fixture = createInstalledFixture("codexc-source-custom-commit-");
    runGit(fixture.checkout, ["config", "user.email", "local@example.invalid"]);
    runGit(fixture.checkout, ["config", "user.name", "Local User"]);
    writeFileSync(join(fixture.checkout, "custom.txt"), "custom");
    runGit(fixture.checkout, ["add", "."]);
    runGit(fixture.checkout, ["commit", "--quiet", "-m", "custom"]);
    let candidateBuilt = false;
    let servicesStopped = false;

    await expect(updateManagedSourceInstallation(fixture.environment, {
      buildCheckout: () => { candidateBuilt = true; },
      projectDir: fixture.checkout,
      repository: fixture.repository,
      stopServices: () => { servicesStopped = true; },
    })).rejects.toThrow("当前源码包含官方 main 之外的提交");

    expect(candidateBuilt).toBe(false);
    expect(servicesStopped).toBe(false);
    expect(readFileSync(join(fixture.checkout, "custom.txt"), "utf8")).toBe("custom");
  });
});

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function createMainRepository(root: string) {
  const repository = join(root, "repository");
  mkdirSync(join(repository, "webui"), { recursive: true });
  mkdirSync(join(repository, "scripts"), { recursive: true });
  runGit(root, ["init", "--quiet", repository]);
  runGit(repository, ["branch", "-M", "main"]);
  runGit(repository, ["config", "user.email", "source-update@example.invalid"]);
  runGit(repository, ["config", "user.name", "Source Update Test"]);
  writePackageVersion(repository, "0.147.0");
  writeFileSync(
    join(repository, "scripts", "codex-public-cli-contract.mjs"),
    "if (process.argv[2] !== '--check-user-settings') process.exit(1);\n",
  );
  runGit(repository, ["add", "."]);
  runGit(repository, ["commit", "--quiet", "-m", "initial"]);
  const initialCommit = gitOutput(repository, ["rev-parse", "HEAD"]);
  writeFileSync(join(repository, "fix.txt"), "fixed");
  runGit(repository, ["add", "."]);
  runGit(repository, ["commit", "--quiet", "-m", "fix"]);
  const latestCommit = gitOutput(repository, ["rev-parse", "HEAD"]);
  return { initialCommit, latestCommit, repository };
}

function createInstalledFixture(prefix: string) {
  const root = temporaryDirectory(prefix);
  const source = createMainRepository(root);
  const home = join(root, "home");
  const installRoot = join(home, ".codex-connect");
  const checkout = join(installRoot, "codex-channels");
  const legacyLauncher = join(installRoot, "bin", "codexc");
  const hiddenLauncher = join(installRoot, ".bin", "codexc");
  const profile = join(home, ".zshrc");
  mkdirSync(installRoot, { recursive: true });
  runGit(root, ["clone", "--quiet", "--branch", "main", source.repository, checkout]);
  runGit(checkout, ["reset", "--quiet", "--hard", source.initialCommit]);
  mkdirSync(join(installRoot, "bin"), { recursive: true });
  writeFileSync(
    legacyLauncher,
    '#!/bin/sh\nexec node "$CODEX_CONNECT_HOME/codex-channels/bin/codexc.mjs" "$@"\n',
  );
  writeFileSync(profile, 'export PATH="$HOME/.codex-connect/bin:$PATH"\n');
  const codex = join(root, "codex");
  writeFileSync(codex, "#!/bin/sh\nprintf '%s\\n' 'codex-cli 0.147.0'\n");
  chmodSync(codex, 0o755);
  return {
    codex,
    checkout,
    environment: {
      ...process.env,
      CODEX_BINARY: codex,
      CODEX_CONNECT_HOME: installRoot,
      CODEX_CONNECT_SERVICE_ROLE: "",
      HOME: home,
    },
    installRoot,
    hiddenLauncher,
    initialCommit: source.initialCommit,
    legacyLauncher,
    latestCommit: source.latestCommit,
    profile,
    repository: source.repository,
  };
}

function writePackageVersion(repository: string, version: string): void {
  const codexVersion = version.split("-", 1)[0];
  mkdirSync(join(repository, "src", "codex-protocol"), { recursive: true });
  writeFileSync(join(repository, "package.json"), JSON.stringify({ version }));
  writeFileSync(join(repository, "webui", "package.json"), JSON.stringify({ version }));
  writeFileSync(
    join(repository, "src", "codex-protocol", "version.json"),
    JSON.stringify({ codexCli: `codex-cli ${codexVersion}` }),
  );
}

function runGit(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function gitOutput(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}
