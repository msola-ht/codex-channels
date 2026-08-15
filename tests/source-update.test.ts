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
  managedSourceCheckout,
  updateManagedSourceInstallation,
} from "../scripts/source-update.mjs";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Git 源码更新", () => {
  it("updates to a newer main commit without requiring a version change", async () => {
    const fixture = createInstalledFixture("codexc-source-update-");
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
    expect(existsSync(fixture.legacyLauncher)).toBe(false);
    expect(readFileSync(fixture.hiddenLauncher, "utf8")).toContain(
      "codex-channels/bin/codexc.mjs",
    );
    expect(readFileSync(fixture.profile, "utf8")).toContain(
      'export PATH="$HOME/.codex-connect/.bin:$PATH"',
    );
    expect(readFileSync(fixture.profile, "utf8")).not.toContain(
      'export PATH="$HOME/.codex-connect/bin:$PATH"',
    );
    expect(readdirSync(fixture.installRoot).filter((name) => name.includes("pre-update")))
      .toEqual([]);
    expect(messages).toEqual([
      [
        "note",
        `Git 源码检查：当前 ${fixture.initialCommit.slice(0, 12)} · main ${fixture.latestCommit.slice(0, 12)}`,
      ],
      ["note", "正在克隆 Git main 候选源码。"],
      ["note", "正在构建并预检候选源码；详细日志仅在失败时显示。"],
      ["note", "候选源码已通过校验，准备切换。"],
      ["note", `源码命令入口已迁移到隐藏目录：${fixture.hiddenLauncher}`],
      [
        "note",
        '当前终端请执行：export PATH="$HOME/.codex-connect/.bin:$PATH"',
      ],
    ]);
  });

  it("migrates the legacy launcher even when main is already current", async () => {
    const fixture = createInstalledFixture("codexc-source-launcher-migration-");
    runGit(fixture.checkout, ["reset", "--quiet", "--hard", fixture.latestCommit]);
    const messages: Array<[string, string]> = [];

    const result = await updateManagedSourceInstallation(fixture.environment, {
      buildCheckout: () => { throw new Error("不应重新构建"); },
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
    expect(existsSync(fixture.legacyLauncher)).toBe(false);
    expect(existsSync(fixture.hiddenLauncher)).toBe(true);
    expect(messages).toContainEqual([
      "note",
      `源码命令入口已迁移到隐藏目录：${fixture.hiddenLauncher}`,
    ]);
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

  it("rejects main when its version no longer matches the installed Codex CLI", async () => {
    const fixture = createInstalledFixture("codexc-source-version-mismatch-");
    writePackageVersion(fixture.repository, "0.148.0");
    runGit(fixture.repository, ["add", "."]);
    runGit(fixture.repository, ["commit", "--quiet", "-m", "upgrade"]);
    let candidateBuilt = false;
    let servicesStopped = false;

    await expect(updateManagedSourceInstallation(fixture.environment, {
      buildCheckout: () => { candidateBuilt = true; },
      projectDir: fixture.checkout,
      repository: fixture.repository,
      stopServices: () => { servicesStopped = true; },
    })).rejects.toThrow("Codex CLI 版本不匹配：需要 0.148.0，当前 0.147.0");

    expect(candidateBuilt).toBe(false);
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
  runGit(root, ["init", "--quiet", repository]);
  runGit(repository, ["branch", "-M", "main"]);
  runGit(repository, ["config", "user.email", "source-update@example.invalid"]);
  runGit(repository, ["config", "user.name", "Source Update Test"]);
  writePackageVersion(repository, "0.147.0");
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
  writeFileSync(join(repository, "package.json"), JSON.stringify({ version }));
  writeFileSync(join(repository, "webui", "package.json"), JSON.stringify({ version }));
}

function runGit(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function gitOutput(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}
