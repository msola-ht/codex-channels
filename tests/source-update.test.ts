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
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import {
  getCodexVersionMismatchRemediation,
  getSourceUpdateFailure,
  inspectManagedSourceUpdatePlan,
  managedSourceCheckout,
  updateManagedSourceInstallation,
  updateInstalledPackage,
  writeSourceUpdateFailure,
} from "../scripts/source-update.mjs";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe.skipIf(process.platform === "win32")("Git 源码更新", () => {
  it.each(["success", "migration-failure", "command-failure"])(
    "uses the candidate database contract and preserves stopped services on %s",
    async (scenario) => {
      const fixture = createInstalledFixture("codexc-database-candidate-");
      const paths = writeDatabaseUpgradeFixture(fixture, fixture.repository, scenario === "migration-failure");
      runGit(fixture.repository, ["add", "."]);
      runGit(fixture.repository, ["commit", "--quiet", "-m", "schema upgrade"]);
      let starts = 0;
      const update = updateManagedSourceInstallation(fixture.environment, {
        projectDir: fixture.checkout,
        repository: fixture.repository,
        buildCheckout: () => undefined,
        stopServices: () => { writeFileSync(paths.stopped, "stopped"); },
        startServices: () => {
          starts += 1;
          expect(databaseVersion(paths.database)).toBe(6);
        },
        installGlobalPackage: () => {
          if (scenario === "command-failure") throw new Error("command failed");
        },
      });
      if (scenario === "success") {
        await expect(update).resolves.toMatchObject({ changed: true });
        expect(starts).toBe(1);
        expect(databaseVersion(paths.database)).toBe(6);
        const database = new DatabaseSync(paths.database, { readOnly: true });
        expect(database.prepare("SELECT value FROM records").get()).toEqual({ value: "keep me" });
        database.close();
      } else {
        let failure: unknown;
        try { await update; } catch (error) { failure = error; }
        expect(getSourceUpdateFailure(failure)).toMatchObject({
          stage: scenario === "command-failure" ? "refresh-command" : "upgrade-databases",
          recovery: { services: "stopped", source: "switched-backup-retained" },
        });
        expect(starts).toBe(0);
        expect(databaseVersion(paths.database)).toBe(5);
      }
      if (scenario !== "command-failure") expect(databaseVersion(paths.backup)).toBe(5);
    },
  );

  it.each([false, true])("runs pending package database upgrades with matching CLI, failure=%s", async (fail) => {
    const fixture = createInstalledFixture("codexc-package-database-");
    const paths = writeDatabaseUpgradeFixture(fixture, fixture.checkout, fail);
    let stops = 0;
    let starts = 0;
    const update = updateInstalledPackage(fixture.environment, {
      projectDir: fixture.checkout,
      stopServices: () => { stops += 1; writeFileSync(paths.stopped, "stopped"); },
      startServices: () => { starts += 1; expect(databaseVersion(paths.database)).toBe(6); },
      installCodexCli: () => { throw new Error("CLI must not be reinstalled"); },
    });
    if (fail) {
      let failure: unknown;
      try { await update; } catch (error) { failure = error; }
      expect(getSourceUpdateFailure(failure)).toMatchObject({
        stage: "upgrade-databases", recovery: { services: "stopped" },
      });
    } else {
      await update;
    }
    expect(stops).toBe(1);
    expect(starts).toBe(fail ? 0 : 1);
    expect(databaseVersion(paths.database)).toBe(fail ? 5 : 6);
    expect(databaseVersion(paths.backup)).toBe(5);
  });

  it("synchronizes Codex for a locally built global package with one service stop/start cycle", async () => {
    const fixture = createInstalledFixture("codexc-package-update-");
    writePackageVersion(fixture.checkout, "0.148.0");
    const calls: string[] = [];
    await updateInstalledPackage(fixture.environment, {
      projectDir: fixture.checkout,
      inspectStaged: async () => ({ services: { installed: true }, databaseUpdatesRequired: false }),
      confirmCodexCliInstall: (request) => {
        expect(request).toEqual({ currentVersion: "0.147.0", requiredVersion: "0.148.0" });
        calls.push("confirm");
        return true;
      },
      installCodexCliForValidation: (version) => {
        calls.push("prepare");
        return writeFakeCodex(join(fixture.installRoot, "candidate-codex"), version);
      },
      validateCodexContract: (_checkout, environment) => {
        expect(environment.CODEX_BINARY).not.toBe(fixture.environment.CODEX_BINARY);
        calls.push("validate");
      },
      stopServices: () => { calls.push("stop"); },
      installCodexCli: (version) => {
        calls.push("install");
        writeFakeCodex(fixture.codex, version);
      },
      startServices: () => { calls.push("restore-services"); },
    });
    expect(calls).toEqual(["confirm", "prepare", "validate", "stop", "install", "restore-services"]);
  });

  it.each(["declined", "noninteractive", "contract", "install"])(
    "does not continue package update after %s failure",
    async (failure) => {
      const fixture = createInstalledFixture("codexc-package-update-failure-");
      writePackageVersion(fixture.checkout, "0.148.0");
      const calls: string[] = [];
      await expect(updateInstalledPackage(fixture.environment, {
        projectDir: fixture.checkout,
        inspectStaged: async () => ({ services: { installed: true }, databaseUpdatesRequired: false }),
        ...(failure === "noninteractive" ? {} : { confirmCodexCliInstall: () => failure !== "declined" }),
        installCodexCliForValidation: (version) => {
          calls.push("prepare");
          return writeFakeCodex(join(fixture.installRoot, "candidate-codex"), version);
        },
        validateCodexContract: () => {
          calls.push("validate");
          if (failure === "contract") throw new Error("contract failed");
        },
        stopServices: () => { calls.push("stop"); },
        installCodexCli: () => {
          calls.push("install");
          throw new Error("install failed");
        },
        startServices: () => { calls.push("restore"); },
      })).rejects.toThrow(failure === "contract" ? /contract failed/u
        : failure === "install" ? /install failed/u : /版本不匹配/u);
      expect(calls).toEqual(failure === "install"
        ? ["prepare", "validate", "stop", "install", "restore"]
        : failure === "contract" ? ["prepare", "validate"] : []);
    },
  );

  it("validates a matching package CLI without reinstalling it", async () => {
    const fixture = createInstalledFixture("codexc-package-current-");
    const calls: string[] = [];
    await updateInstalledPackage(fixture.environment, {
      projectDir: fixture.checkout,
      inspectStaged: async () => ({ services: { installed: false }, databaseUpdatesRequired: false }),
      confirmCodexCliInstall: () => { throw new Error("unexpected confirmation"); },
      installCodexCli: () => { throw new Error("unexpected install"); },
      validateCodexContract: () => { calls.push("validate"); },
    });
    expect(calls).toEqual(["validate"]);
  });

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
      steps: [
        "inspect",
        "clone-candidate",
        "validate-candidate",
        "build-candidate",
        "inspect-candidate",
        "prepare-codex-cli",
        "validate-codex-contract",
        "stop-services",
        "install-codex-cli",
        "switch-source",
        "refresh-command",
        "upgrade-databases",
        "restore-services",
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
      inspectStaged: async () => ({ services: { installed: false }, databaseUpdatesRequired: false }),
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
      "install-codex-cli:started",
      "install-codex-cli:completed",
      "switch-source:started",
      "switch-source:completed",
      "refresh-command:started",
      "refresh-command:completed",
      "upgrade-databases:started",
      "upgrade-databases:completed",
      "cleanup:started",
      "cleanup:completed",
    ]);
  });

  it("updates to a newer main commit without requiring a version change", async () => {
    const fixture = createInstalledFixture("codexc-source-update-");
    let globalInstalls = 0;
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
      inspectStaged: async () => ({ services: { installed: false }, databaseUpdatesRequired: false }),
      installGlobalPackage: () => { globalInstalls += 1; },
      projectDir: fixture.checkout,
      repository: fixture.repository,
      writeMessage: (kind, message) => { messages.push([kind, message]); },
    });

    expect(result).toEqual({
      changed: true,
      commit: fixture.latestCommit,
      managed: true,
      previousVersion: "0.147.0",
      version: "0.147.0",
    });
    expect(readFileSync(join(fixture.checkout, "fix.txt"), "utf8")).toBe("fixed");
    expect(globalInstalls).toBe(1);
    expect(existsSync(fixture.legacyLauncher)).toBe(true);
    expect(readFileSync(fixture.profile, "utf8")).toContain("PATH");
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
      ["note", "源码命令已刷新到 npm 全局安装。"],
    ]);
  });

  it("updates a stable source checkout to a Gateway fix release", async () => {
    const fixture = createInstalledFixture("codexc-source-update-fix-release-");
    writePackageVersion(fixture.repository, "0.147.0-fix1");
    runGit(fixture.repository, ["add", "."]);
    runGit(fixture.repository, ["commit", "--quiet", "-m", "fix release"]);

    const result = await updateManagedSourceInstallation(fixture.environment, {
      buildCheckout: () => undefined,
      inspectStaged: async () => ({ services: { installed: false }, databaseUpdatesRequired: false }),
      installGlobalPackage: () => undefined,
      projectDir: fixture.checkout,
      repository: fixture.repository,
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
      inspectStaged: async () => ({ services: { installed: false }, databaseUpdatesRequired: false }),
      installGlobalPackage: () => undefined,
      projectDir: fixture.checkout,
      repository: fixture.repository,
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
      inspectStaged: async () => ({ services: { installed: false }, databaseUpdatesRequired: false }),
      installGlobalPackage: () => undefined,
      projectDir: fixture.checkout,
      repository: fixture.repository,
    });

    expect(result).toMatchObject({
      changed: true,
      previousVersion: "0.148.0-rc.1",
      version: "0.148.0",
    });
  });

  it("recognizes a globally installed command through the managed Git marker", () => {
    const fixture = createInstalledFixture("codexc-source-global-marker-");
    const globalPackage = join(fixture.installRoot, "npm-global-package");
    mkdirSync(globalPackage);
    runGit(fixture.checkout, ["config", "--local", "codex-connect.managed-source", "true"]);

    expect(managedSourceCheckout(fixture.environment, globalPackage)).toBe(fixture.checkout);
  });

  it.each(["older", "matching", "declined"])(
    "handles a %s CLI when managed source is already current",
    async (state) => {
      const fixture = createInstalledFixture("codexc-current-source-cli-");
      runGit(fixture.checkout, ["reset", "--quiet", "--hard", fixture.latestCommit]);
      if (state !== "matching") writeFakeCodex(fixture.codex, "0.146.0");
      const calls: string[] = [];
      const update = updateManagedSourceInstallation(fixture.environment, {
        projectDir: fixture.checkout,
        repository: fixture.repository,
        buildCheckout: () => { throw new Error("unexpected rebuild"); },
        inspectStaged: async () => ({ services: { installed: true }, databaseUpdatesRequired: false }),
        confirmCodexCliInstall: () => {
          calls.push("confirm");
          return state !== "declined";
        },
        installCodexCliForValidation: (version) => {
          calls.push("prepare");
          return writeFakeCodex(join(fixture.installRoot, "candidate-codex"), version);
        },
        validateCodexContract: () => { calls.push("validate"); },
        stopServices: () => { calls.push("stop"); },
        installCodexCli: (version) => {
          calls.push("install");
          writeFakeCodex(fixture.codex, version);
        },
        installGlobalPackage: () => { calls.push("refresh"); },
        startServices: () => { calls.push("restore"); },
      });
      if (state === "declined") {
        await expect(update).rejects.toThrow("版本不匹配");
        expect(calls).toEqual(["confirm"]);
      } else {
        expect(await update).toMatchObject({ changed: false, commit: fixture.latestCommit });
        expect(calls).toEqual(state === "matching"
          ? ["validate"]
          : ["confirm", "prepare", "validate", "stop", "install", "restore"]);
      }
      expect(gitOutput(fixture.checkout, ["rev-parse", "HEAD"])).toBe(fixture.latestCommit);
    },
  );

  it("restores the old checkout and services when switching the candidate fails", async () => {
    const fixture = createInstalledFixture("codexc-source-switch-failure-");
    let renameCalls = 0;
    let stopCalls = 0;
    let startCalls = 0;

    await expect(updateManagedSourceInstallation(fixture.environment, {
      buildCheckout: () => undefined,
      inspectStaged: async () => ({ services: { installed: true }, databaseUpdatesRequired: false }),
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
      inspectStaged: async () => ({ services: { installed: true }, databaseUpdatesRequired: false }),
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
        inspectStaged: async () => ({ services: { installed: true }, databaseUpdatesRequired: false }),
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

    let failure: unknown;
    try {
      await updateManagedSourceInstallation(fixture.environment, {
        buildCheckout: () => undefined,
        inspectStaged: async () => ({ services: { installed: true }, databaseUpdatesRequired: false }),
        installGlobalPackage: () => { throw new Error("global install failed"); },
        projectDir: fixture.checkout,
        repository: fixture.repository,
        startServices: () => { startCalls += 1; },
        stopServices: () => undefined,
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("main 源码已切换，但更新未完成");
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
        inspectStaged: async () => ({ services: { installed: true }, databaseUpdatesRequired: false }),
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
      .toBe("源码已切换但更新失败，且核心服务未能恢复运行");
    expect((failure as AggregateError).errors.map((error) => (error as Error).message))
      .toEqual([
        expect.stringContaining("main 源码已切换，但更新未完成"),
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
      inspectStaged: async () => ({ services: { installed: true }, databaseUpdatesRequired: false }),
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
    const preparedVersions: string[] = [];
    const messages: Array<[string, string]> = [];

    const result = await updateManagedSourceInstallation(fixture.environment, {
      buildCheckout: () => undefined,
      confirmCodexCliInstall: (request) => {
        confirmations.push(request);
        return true;
      },
      inspectStaged: async () => ({ services: { installed: false }, databaseUpdatesRequired: false }),
      installGlobalPackage: () => undefined,
      projectDir: fixture.checkout,
      repository: fixture.repository,
      runCommand: (command, args, options) => {
        if (
          (command === "npm" || command === "npm.cmd")
          && args[0] === "install"
          && args.includes("--prefix")
        ) {
          const prefixIndex = args.indexOf("--prefix");
          const prefix = args[prefixIndex + 1];
          const packageName = args.find((argument) => argument.startsWith("@openai/codex@"));
          if (!prefix || !packageName) throw new Error("测试缺少临时 Codex 安装参数");
          const version = packageName.slice("@openai/codex@".length);
          preparedVersions.push(version);
          writeFakeCodex(
            join(prefix, "node_modules", ".bin", process.platform === "win32" ? "codex.cmd" : "codex"),
            version,
          );
          return;
        }
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
      writeMessage: (kind, message) => { messages.push([kind, message]); },
    });

    expect(confirmations).toEqual([{
      currentVersion: "0.147.0",
      requiredVersion: "0.148.0",
    }]);
    expect(preparedVersions).toEqual(["0.148.0"]);
    expect(installedVersions).toEqual(["0.148.0"]);
    expect(messages).toContainEqual([
      "note",
      "候选合同已通过，正在全局安装 @openai/codex@0.148.0。",
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

  it("stops installed services before applying a confirmed Codex upgrade", async () => {
    const fixture = createInstalledFixture("codexc-source-version-install-services-");
    writePackageVersion(fixture.repository, "0.148.0");
    runGit(fixture.repository, ["add", "."]);
    runGit(fixture.repository, ["commit", "--quiet", "-m", "upgrade"]);
    const calls: string[] = [];
    const candidateCodex = join(fixture.installRoot, "candidate-codex");

    await updateManagedSourceInstallation(fixture.environment, {
      buildCheckout: () => undefined,
      confirmCodexCliInstall: () => true,
      installCodexCliForValidation: (version) => {
        calls.push("prepare-codex");
        return writeFakeCodex(candidateCodex, version);
      },
      validateCodexContract: () => {
        calls.push("validate-codex-contract");
      },
      inspectStaged: async () => ({ services: { installed: true }, databaseUpdatesRequired: false }),
      stopServices: () => {
        calls.push("stop-services");
      },
      installCodexCli: (version) => {
        calls.push("install-codex");
        writeFakeCodex(fixture.codex, version);
      },
      installGlobalPackage: () => {
        calls.push("install-gateway");
      },
      startServices: () => { calls.push("restore-services"); },
      projectDir: fixture.checkout,
      repository: fixture.repository,
    });

    expect(calls).toEqual([
      "prepare-codex",
      "validate-codex-contract",
      "stop-services",
      "install-codex",
      "install-gateway",
      "restore-services",
    ]);
  });

  it("keeps the current source and services when the candidate Codex contract needs adaptation", async () => {
    const fixture = createInstalledFixture("codexc-source-contract-mismatch-");
    writePackageVersion(fixture.repository, "0.148.0");
    runGit(fixture.repository, ["add", "."]);
    runGit(fixture.repository, ["commit", "--quiet", "-m", "upgrade"]);
    let servicesStopped = false;
    let globalInstalled = false;
    const candidateCodex = join(fixture.installRoot, "candidate-codex");

    let failure: unknown;
    try {
      await updateManagedSourceInstallation(fixture.environment, {
        buildCheckout: () => undefined,
        confirmCodexCliInstall: () => true,
        inspectStaged: async () => ({ services: { installed: true }, databaseUpdatesRequired: false }),
        installCodexCliForValidation: (version) => writeFakeCodex(candidateCodex, version),
        installCodexCli: (version) => {
          globalInstalled = true;
          writeFileSync(
            fixture.codex,
            `#!/bin/sh\nprintf '%s\\n' 'codex-cli ${version}'\n`,
          );
          chmodSync(fixture.codex, 0o755);
        },
        installGlobalPackage: () => { globalInstalled = true; },
        projectDir: fixture.checkout,
        repository: fixture.repository,
        stopServices: () => { servicesStopped = true; },
        validateCodexContract: (_checkout, environment) => {
          expect(environment.CODEX_BINARY).toBe(candidateCodex);
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
    expect(execFileSync(fixture.codex, ["--version"], { encoding: "utf8" }).trim())
      .toBe("codex-cli 0.147.0");
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
        inspectStaged: async () => ({ services: { installed: true }, databaseUpdatesRequired: false }),
        installCodexCliForValidation: (version) => writeFakeCodex(
          join(fixture.installRoot, "candidate-codex"),
          version,
        ),
        installCodexCli: () => { throw new Error("npm install failed"); },
        projectDir: fixture.checkout,
        repository: fixture.repository,
        stopServices: () => { servicesStopped = true; },
        startServices: () => undefined,
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
    expect(servicesStopped).toBe(true);
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

function databaseVersion(path: string): number {
  const database = new DatabaseSync(path, { readOnly: true });
  try { return Number(database.prepare("PRAGMA user_version").get()?.user_version); }
  finally { database.close(); }
}

function writeDatabaseUpgradeFixture(
  fixture: ReturnType<typeof createInstalledFixture>,
  checkout: string,
  fail: boolean,
) {
  const databasePath = join(fixture.installRoot, "upgrade.sqlite3");
  const database = new DatabaseSync(databasePath);
  database.exec("CREATE TABLE records (value TEXT); INSERT INTO records VALUES ('keep me'); PRAGMA user_version=5");
  database.close();
  writeFileSync(join(checkout, "scripts", "local-installation.mjs"), `
import { existsSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
export function inspectGatewayConfiguration(environment) { return { configPath: join(environment.CODEX_CONNECT_HOME, 'config.toml') }; }
export function inspectCoreServiceInstallation() { return { installed: true }; }
export function inspectDatabaseUpdates(environment = process.env) {
  const path = join(environment.CODEX_CONNECT_HOME, 'upgrade.sqlite3');
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const version = db.prepare('PRAGMA user_version').get().user_version;
    if (version !== 5 && version !== 6) throw new Error('unsupported schema');
    return { required: version === 5 };
  } finally { db.close(); }
}
export function applyDatabaseUpdates() {
  const root = process.env.CODEX_CONNECT_HOME;
  const path = join(root, 'upgrade.sqlite3');
  if (!existsSync(join(root, 'stopped'))) throw new Error('services not stopped');
  if (!inspectDatabaseUpdates().required) return;
  copyFileSync(path, path + '.backup');
  const db = new DatabaseSync(path);
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec('ALTER TABLE records ADD COLUMN note TEXT; PRAGMA user_version=6');
    if (${fail}) throw new Error('migration failed');
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  finally { db.close(); }
  if (inspectDatabaseUpdates().required) throw new Error('target schema not reached');
}
`);
  return { database: databasePath, backup: `${databasePath}.backup`, stopped: join(fixture.installRoot, "stopped") };
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
    join(repository, "scripts", "local-installation.mjs"),
    "export function applyDatabaseUpdates() {}\n",
  );
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

function writeFakeCodex(path: string, version: string): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `#!/bin/sh\nprintf '%s\\n' 'codex-cli ${version}'\n`);
  chmodSync(path, 0o755);
  return path;
}

function runGit(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function gitOutput(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}
