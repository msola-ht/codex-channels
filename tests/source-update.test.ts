import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { disableCodexDaemonAutoStart } from "../scripts/codex-user-config.mjs";

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

vi.mock("../scripts/service-status.mjs", () => ({
  inspectManagedServiceStatus: ({ target }: { target: string }) => ({
    services: target === "webui" ? [{ target: "webui", running: false, state: "not-found" }]
      : ["app-server", "gateway"].map(target => ({ target, running: true, state: "active/running" })),
  }),
}));

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe.skipIf(process.platform === "win32")("Git 源码更新", () => {
  it.each([undefined, "keep-user-model"])("preserves the model when disabling daemon auto-start: %s", async model => {
    const config = { ...(model === undefined ? {} : { model }), features: { daemon_auto_start: true } };
    const writes: unknown[] = [];
    let closed = false;
    await disableCodexDaemonAutoStart({}, { createClient: async () => ({
      connect: async () => undefined,
      close: async () => { closed = true; },
      readUserConfigSnapshot: async () => ({ config, version: "handoff-version" }),
      writeUserConfigEdits: async (edits, options) => { writes.push({ edits, options }); },
    }) });
    expect(writes).toEqual([{ edits: [{ keyPath: "features.daemon_auto_start", value: false }],
      options: { expectedVersion: "handoff-version" } }]);
    expect(closed).toBe(true);
  });

  it.each([undefined, true, false])("does not seed an unset model during update (daemon=%s)", async previous => {
    const writes: unknown[] = [];
    await disableCodexDaemonAutoStart({}, { createClient: async () => ({
      connect: async () => undefined,
      close: async () => undefined,
      readUserConfigSnapshot: async () => ({ config: { features: { daemon_auto_start: previous } }, version: "v1" }),
      writeUserConfigEdits: async (edits, options) => { writes.push({ edits, options }); },
    }) });
    expect(writes).toEqual(previous === false ? [] : [{
      edits: [{ keyPath: "features.daemon_auto_start", value: false }], options: { expectedVersion: "v1" },
    }]);
  });

  it.each([undefined, true, false])("disables daemon auto-start with version protection (previous=%s)", async previous => {
    const config = { model: "keep", features: { daemon_auto_start: previous, write_stdin_approval: true } };
    const writes: unknown[] = [];
    let closed = false;
    await disableCodexDaemonAutoStart({}, { createClient: async () => ({
      connect: async () => undefined,
      close: async () => { closed = true; },
      readUserConfigSnapshot: async () => ({ config, version: "v1" }),
      writeUserConfigEdits: async (edits, options) => { writes.push({ edits, options }); },
    }) });
    expect(writes).toEqual(previous === false ? [] : [{
      edits: [{ keyPath: "features.daemon_auto_start", value: false }], options: { expectedVersion: "v1" },
    }]);
    expect(config.features.write_stdin_approval).toBe(true);
    expect(closed).toBe(true);
  });

  it("reports daemon configuration failure without claiming update success", async () => {
    const fixture = createInstalledFixture("daemon-settings-failure-");
    const messages: string[] = [];
    await expect(updateInstalledPackage(fixture.environment, {
      projectDir: fixture.checkout,
      inspectStaged: async () => ({ services: { installed: false } }),
      validateCodexContract: () => {},
      runCommand: (_command, args) => {
        if (args.some(arg => arg.includes("disableCodexDaemonAutoStart"))) throw new Error("config conflict");
      },
      writeMessage: (_kind, message) => { messages.push(message); },
    })).rejects.toMatchObject({ message: expect.stringContaining("config conflict") });
    expect(messages.some(message => message.includes("检查完成"))).toBe(false);
  });

  it("closes the config client and propagates a concurrent write conflict", async () => {
    let closed = false;
    await expect(disableCodexDaemonAutoStart({}, { createClient: async () => ({
      connect: async () => undefined,
      close: async () => { closed = true; },
      readUserConfigSnapshot: async () => ({ config: {}, version: "stale" }),
      writeUserConfigEdits: async () => { throw new Error("version conflict"); },
    }) })).rejects.toThrow("version conflict");
    expect(closed).toBe(true);
  });

  it("restores services after daemon settings fail following successful preflight", async () => {
    const fixture = createInstalledFixture("daemon-settings-restore-");
    let restored = false;
    const update = updateManagedSourceInstallation(fixture.environment, {
      projectDir: fixture.checkout, repository: fixture.repository,
      buildCheckout: () => {}, installGlobalPackage: () => {}, validateCodexContract: () => {},
      inspectStaged: async () => ({ services: { installed: true } }),
      stopServices: () => {}, inspectServices: () => [],
      startServices: () => { restored = true; },
      runCommand: (command, args, options) => {
        if (args.some(arg => arg.includes("disableCodexDaemonAutoStart"))) throw new Error("config conflict");
        execFileSync(command, args, {
          cwd: options.cwd as string, env: options.environment as NodeJS.ProcessEnv, stdio: "ignore",
        });
      },
    });
    await expect(update).rejects.toThrow("config conflict");
    const error = await update.catch(value => value);
    expect(getSourceUpdateFailure(error)).toMatchObject({ stage: "configure-codex-daemon", recovery: { services: "restored" } });
    expect(restored).toBe(true);
  });

  it.each([
    { running: false, core: true, webui: true },
    { running: true, core: true, webui: true },
    { running: false, core: false, webui: true },
    { running: false, core: false, webui: false },
  ])("restores only previously running services after package update (%j)", async ({ running, core, webui }) => {
    const fixture = createInstalledFixture("relay-update-state-");
    writePackageVersion(fixture.checkout, "0.148.0");
    const config = join(fixture.installRoot, "config.toml");
    writeFileSync(config, `version=1\ndefault_workspace="main"\n[codex]\n[telegram]\nbot_token="fixture"\nallowed_user_ids=[1]\n[[workspaces]]\nid="main"\nname="Main"\ncwd=${JSON.stringify(fixture.installRoot)}\n[model_relay]\nenabled=true\n`);
    const directory = process.platform === "darwin" ? join(fixture.environment.HOME, "Library", "LaunchAgents") : join(fixture.environment.HOME, ".config", "systemd", "user");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, process.platform === "darwin" ? "com.hegenai.codex-model-relay.plist" : "codex-connect-model-relay.service"), "fixture");
    const calls: string[][] = [];
    await updateInstalledPackage({ ...fixture.environment, CODEX_CONNECT_CONFIG_FILE: config, XDG_CONFIG_HOME: join(fixture.environment.HOME, ".config") }, {
      projectDir: fixture.checkout, inspectStaged: async () => ({ services: { installed: true } }),
      inspectServices: () => [{ target: "app-server", running: core }, { target: "gateway", running: core },
        { target: "webui", running: webui }, { target: "model-relay", running }], confirmCodexCliInstall: () => true,
      installCodexCliForValidation: version => writeFakeCodex(join(fixture.installRoot, "candidate"), version),
      validateCodexContract: () => {}, installCodexCli: version => { writeFakeCodex(fixture.codex, version); },
      runCommand: (_command, args) => { calls.push(args); },
    });
    expect(calls.filter(args => args[1] === "service").map(args => args.slice(2))).toEqual([
      ...(webui ? [["stop", "webui"]] : []), ...(running ? [["stop", "relay"]] : []), ...(core ? [["stop", "gateway"], ["stop", "app-server"]] : []),
      ...(core ? [["start", "app-server"], ["start", "gateway"]] : []), ...(running ? [["start", "relay"]] : []), ...(webui ? [["start", "webui"]] : []),
    ]);
  });

  it.each([false, true])("retains the captured Relay state on failed source update recovery (running=%s)", async running => {
    const fixture = createInstalledFixture("relay-update-recovery-");
    let captured = false; const restored: boolean[] = [];
    await expect(updateManagedSourceInstallation(fixture.environment, {
      projectDir: fixture.checkout, repository: fixture.repository, buildCheckout: () => {},
      inspectStaged: async () => ({ services: { installed: true } }),
      inspectServices: () => { captured = true; return [{ target: "model-relay", running }]; }, validateCodexContract: () => {},
      stopServices: () => { expect(captured).toBe(true); throw new Error("fixture stop failure"); },
      startServices: (_checkout, _environment, _options, services) => { restored.push(services[0]!.running); throw new Error("fixture recovery failure"); },
    })).rejects.toThrow("未能恢复");
    expect(restored).toEqual([running]);
  });

  it.each(["", "codex"])("installs a missing default CLI through the confirmed candidate flow (%s)", async binary => {
    const fixture = createInstalledFixture("codexc-package-missing-cli-");
    const bin = join(fixture.installRoot, "empty-bin");
    mkdirSync(bin);
    const environment = { ...fixture.environment, CODEX_BINARY: binary, PATH: bin };
    const calls: string[] = [];
    await updateInstalledPackage(environment, {
      projectDir: fixture.checkout,
      inspectStaged: async () => ({ services: { installed: false } }),
      confirmCodexCliInstall: (request) => {
        expect(request).toEqual({ currentVersion: undefined, requiredVersion: "0.147.0" });
        calls.push("confirm"); return true;
      },
      installCodexCliForValidation: (version) => {
        calls.push("prepare"); return writeFakeCodex(join(fixture.installRoot, "candidate"), version);
      },
      validateCodexContract: () => { calls.push("validate"); },
      installCodexCli: (version) => { calls.push("install"); writeFakeCodex(join(bin, "codex"), version); },
      stopServices: () => { throw new Error("no installed service"); },
      startServices: () => { throw new Error("no installed service"); },
    });
    expect(calls).toEqual(["confirm", "prepare", "validate", "install"]);
  });

  it.each(["missing", "mismatch"])("does not replace an explicitly configured Codex binary (%s)", async state => {
    const fixture = createInstalledFixture("codexc-package-explicit-missing-");
    let confirmed = false;
    writePackageVersion(fixture.checkout, "0.148.0");
    await expect(updateInstalledPackage({ ...fixture.environment, CODEX_BINARY: state === "missing" ? join(fixture.installRoot, "absent") : fixture.codex }, {
      projectDir: fixture.checkout,
      inspectStaged: async () => ({ services: { installed: false } }),
      confirmCodexCliInstall: () => { confirmed = true; return true; },
    })).rejects.toThrow("CODEX_BINARY");
    expect(confirmed).toBe(false);
  });

  it("synchronizes Codex for a locally built global package with one service stop/start cycle", async () => {
    const fixture = createInstalledFixture("codexc-package-update-");
    writePackageVersion(fixture.checkout, "0.148.0");
    const calls: string[] = [];
    await updateInstalledPackage(fixture.environment, {
      projectDir: fixture.checkout,
      inspectStaged: async () => ({ services: { installed: true } }),
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
        inspectStaged: async () => ({ services: { installed: true } }),
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

  it.each([false, true])("validates a matching package CLI without reinstalling it, display failure=%s", async (displayFailure) => {
    const fixture = createInstalledFixture("codexc-package-current-");
    const calls: string[] = [];
    const messages: Array<[string, string]> = [];
    await updateInstalledPackage(fixture.environment, {
      projectDir: fixture.checkout,
      writeMessage: (kind, message) => {
        messages.push([kind, message]);
        if (displayFailure) throw new Error("display failed");
      },
      inspectStaged: async () => ({ services: { installed: false } }),
      confirmCodexCliInstall: () => { throw new Error("unexpected confirmation"); },
      installCodexCli: () => { throw new Error("unexpected install"); },
      validateCodexContract: () => { calls.push("validate"); },
    });
    expect(calls).toEqual(["validate"]);
    expect(messages).toEqual([
      ["note", "正在检查配套 Codex CLI、当前配置和数据库结构。"],
      ["note", "已关闭 Codex 原生 daemon 自动启动；现有后台不受影响，项目服务继续由 codexc service 管理。"],
      ["success", "检查完成：配套 Codex CLI 0.147.0 无需更新，数据库结构有效。"],
    ]);
  });

  it("inspects a managed checkout without exposing the repository address", () => {
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
        "configure-codex-daemon",
        "restore-services",
        "cleanup",
      ],
    });
    expect(JSON.stringify(plan)).not.toContain(fixture.repository);
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
      inspectStaged: async () => ({ services: { installed: false } }),
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
      ["note", "已关闭 Codex 原生 daemon 自动启动；现有后台不受影响，项目服务继续由 codexc service 管理。"],
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
        inspectStaged: async () => ({ services: { installed: true } }),
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

  it("keeps services stopped when the global command refresh fails after switching source", async () => {
    const fixture = createInstalledFixture("codexc-source-global-install-failure-");
    let startCalls = 0;

    let failure: unknown;
    try {
      await updateManagedSourceInstallation(fixture.environment, {
        buildCheckout: () => undefined,
        inspectStaged: async () => ({ services: { installed: true } }),
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
    expect((failure as Error).message).toContain("源码已切换但更新失败");
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
        services: "failed",
        source: "switched-backup-retained",
        backupPath: expect.stringContaining("pre-update"),
      },
    });
    expect(startCalls).toBe(0);
    expect(readFileSync(join(fixture.checkout, "fix.txt"), "utf8")).toBe("fixed");
    expect(readdirSync(fixture.installRoot).some((name) => name.includes("pre-update")))
      .toBe(true);
  });

  it("reports incomplete global installation and blocks service recovery after switching source", async () => {
    const fixture = createInstalledFixture("codexc-source-global-install-start-failure-");
    let failure: unknown;
    const startServices = vi.fn();

    try {
      await updateManagedSourceInstallation(fixture.environment, {
        buildCheckout: () => undefined,
        inspectStaged: async () => ({ services: { installed: true } }),
        installGlobalPackage: () => { throw new Error("global install failed"); },
        projectDir: fixture.checkout,
        repository: fixture.repository,
        startServices,
        stopServices: () => undefined,
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(AggregateError);
    expect(startServices).not.toHaveBeenCalled();
    expect((failure as AggregateError).message)
      .toBe("源码已切换但更新失败，且核心服务未能恢复运行");
    expect((failure as AggregateError).errors.map((error) => (error as Error).message))
      .toEqual([
        expect.stringContaining("main 源码已切换，但更新未完成"),
        expect.stringContaining("全局程序安装未完成"),
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
    const preparedVersions: string[] = [];
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
      inspectStaged: async () => ({ services: { installed: true } }),
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
        inspectStaged: async () => ({ services: { installed: true } }),
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
        inspectStaged: async () => ({ services: { installed: true } }),
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
    "export function inspectDatabases() { return {}; }\n",
  );
  writeFileSync(join(repository, "scripts", "codex-user-config.mjs"),
    "export async function disableCodexDaemonAutoStart() {}\n");
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
  mkdirSync(installRoot, { recursive: true });
  runGit(root, ["clone", "--quiet", "--branch", "main", source.repository, checkout]);
  runGit(checkout, ["reset", "--quiet", "--hard", source.initialCommit]);
  const codex = join(root, "codex");
  writeFileSync(codex, "#!/bin/sh\nprintf '%s\\n' 'codex-cli 0.147.0'\n");
  chmodSync(codex, 0o755);
  return {
    codex,
    checkout,
    environment: {
      ...process.env,
      CODEX_BINARY: "codex",
      PATH: `${root}${delimiter}${process.env.PATH ?? ""}`,
      CODEX_CONNECT_HOME: installRoot,
      CODEX_CONNECT_SERVICE_ROLE: "",
      HOME: home,
    },
    installRoot,
    initialCommit: source.initialCommit,
    latestCommit: source.latestCommit,
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
