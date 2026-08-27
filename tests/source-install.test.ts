import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { uninstallManagedSourceInstallation } from "../scripts/source-uninstall.mjs";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Linux/macOS Git 源码安装", () => {
  it("braces shell variables before non-ASCII text", () => {
    const installer = readFileSync(resolve("install.sh"), "utf8");

    expect(installer).not.toMatch(/\$[A-Za-z_][A-Za-z0-9_]*\P{ASCII}/u);
  });

  it("clones main under .codex-connect and installs the command globally", () => {
    const root = temporaryDirectory("codexc-source-install-");
    const repository = createFixtureRepository(root);
    const home = join(root, "home");
    const result = runInstaller(root, repository, home);

    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(result.stdout).toContain("npm 检测通过");
    expect(result.stdout).toContain("未检测到 npm 全局版");
    expect(result.stdout).toContain("Codex CLI 检测通过");
    expect(result.stdout).toContain("已登录");
    const installRoot = join(home, ".codex-connect");
    const checkout = join(installRoot, "codex-channels");
    const globalPackage = join(
      root,
      "npm-global",
      "lib",
      "node_modules",
      "@hegenai",
      "codexc",
    );
    const launcher = join(root, "npm-global", "bin", "codexc");
    expect(existsSync(join(checkout, ".git"))).toBe(true);
    expect(existsSync(join(checkout, "dist", "main.js"))).toBe(true);
    expect(existsSync(join(checkout, "webui", "dist", "index.html"))).toBe(true);
    expect(existsSync(join(globalPackage, "package.json"))).toBe(true);
    expect(execFileSync(launcher, ["--version"], {
      encoding: "utf8",
      env: { ...process.env, HOME: home },
    }).trim()).toBe("0.147.0");
    expect(existsSync(join(installRoot, ".bin"))).toBe(false);
    expect(existsSync(join(home, ".profile"))).toBe(false);
    expect(existsSync(join(installRoot, "bin"))).toBe(false);
    expect(execFileSync("git", ["config", "--local", "--get", "codex-connect.managed-source"], {
      cwd: checkout,
      encoding: "utf8",
    }).trim()).toBe("true");
    expect(execFileSync("git", ["config", "--local", "--get", "codex-connect.npm-prefix"], {
      cwd: checkout,
      encoding: "utf8",
    }).trim()).toBe(join(root, "npm-global"));
  }, 30_000);

  it("removes the partial checkout and launcher when the build fails", () => {
    const root = temporaryDirectory("codexc-source-install-failure-");
    const repository = createFixtureRepository(root, { failBuild: true });
    const home = join(root, "home");

    const result = runInstaller(root, repository, home);

    expect(result.status).not.toBe(0);
    expect(existsSync(join(home, ".codex-connect", "codex-channels"))).toBe(false);
    expect(existsSync(join(home, ".codex-connect", ".bin", "codexc"))).toBe(false);
  });

  it("replaces an existing global npm package with the built main source", () => {
    const root = temporaryDirectory("codexc-source-install-npm-");
    const repository = createFixtureRepository(root);
    const home = join(root, "home");
    const npmManifest = join(
      root,
      "npm-global",
      "lib",
      "node_modules",
      "@hegenai",
      "codexc",
      "package.json",
    );
    mkdirSync(resolve(npmManifest, ".."), { recursive: true });
    writeFileSync(npmManifest, JSON.stringify({ version: "0.146.1" }));

    const result = runInstaller(root, repository, home);

    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(result.stdout).toContain("检测到 npm 全局版 @hegenai/codexc@0.146.1");
    expect(JSON.parse(readFileSync(npmManifest, "utf8")).version).toBe("0.147.0");
  }, 30_000);

  it("installs a missing Codex CLI and reports that login is still required", () => {
    const root = temporaryDirectory("codexc-source-install-codex-");
    const repository = createFixtureRepository(root);
    const home = join(root, "home");

    const result = runInstaller(root, repository, home, { codexInstalled: false });

    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(result.stdout).toContain(
      "未检测到 Codex CLI，正在安装 @openai/codex@0.147.0",
    );
    expect(result.stdout).toContain("Codex CLI 0.147.0 已安装");
    expect(result.stdout).toContain("0.147.0 · 未登录或登录状态不可用");
    expect(result.stdout).toContain("下一步：codex login status");
    expect(result.stdout).toContain("如未登录：codex login");
    expect(existsSync(join(root, "fake-bin", "codex"))).toBe(true);
  }, 15_000);

  it("uses the protocol base version for a Gateway fix release", () => {
    const root = temporaryDirectory("codexc-source-install-fix-");
    const repository = createFixtureRepository(root, {
      gatewayVersion: "0.147.0-fix1",
    });
    const home = join(root, "home");

    const result = runInstaller(root, repository, home, { codexInstalled: false });

    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(result.stdout).toContain(
      "未检测到 Codex CLI，正在安装 @openai/codex@0.147.0",
    );
    expect(result.stdout).not.toContain("@openai/codex@0.147.0-fix1");
  }, 15_000);

  it("does not modify Shell PATH when no terminal is attached", () => {
    const root = temporaryDirectory("codexc-source-install-no-tty-");
    const repository = createFixtureRepository(root);
    const home = join(root, "home");

    const result = runInstaller(root, repository, home, { shell: "/bin/zsh" });

    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(result.stdout).toContain("npm 全局命令已安装");
    expect(result.stdout).not.toContain("export PATH");
    expect(existsSync(join(home, ".zshrc"))).toBe(false);
  }, 15_000);

  it("uninstalls the managed source and services while preserving user data", async () => {
    const root = temporaryDirectory("codexc-source-uninstall-");
    const installRoot = join(root, ".codex-connect");
    const checkout = join(installRoot, "codex-channels");
    const launcher = join(installRoot, ".bin", "codexc");
    const config = join(installRoot, "config.toml");
    const database = join(installRoot, "data", "gateway.sqlite3");
    const profile = join(root, ".zshrc");
    runGit(root, ["init", "--quiet", checkout]);
    mkdirSync(resolve(launcher, ".."), { recursive: true });
    mkdirSync(resolve(database, ".."), { recursive: true });
    writeFileSync(join(checkout, "package.json"), JSON.stringify({ version: "0.147.0" }));
    writeFileSync(
      launcher,
      `#!/bin/sh\nexec node "${checkout}/bin/codexc.mjs" "$@"\n`,
    );
    writeFileSync(config, "version = 1\n");
    writeFileSync(database, "preserved");
    writeFileSync(
      profile,
      "export PATH=\"/custom/bin:$PATH\"\n\n"
        + "# Codex Connect\n"
        + "export PATH=\"$HOME/.codex-connect/.bin:$PATH\"\n",
    );
    let serviceUninstalls = 0;
    let globalUninstalls = 0;

    const result = await uninstallManagedSourceInstallation(
      { ...process.env, CODEX_CONNECT_HOME: installRoot, HOME: root },
      {
        projectDir: checkout,
        uninstallServices: () => { serviceUninstalls += 1; },
        uninstallGlobalPackage: () => { globalUninstalls += 1; },
      },
    );

    expect(result).toEqual({ checkout, launcher });
    expect(serviceUninstalls).toBe(1);
    expect(globalUninstalls).toBe(1);
    expect(existsSync(checkout)).toBe(false);
    expect(existsSync(launcher)).toBe(false);
    expect(readFileSync(config, "utf8")).toBe("version = 1\n");
    expect(readFileSync(database, "utf8")).toBe("preserved");
    expect(readFileSync(profile, "utf8")).toBe('export PATH="/custom/bin:$PATH"\n');
  });

  it("refuses to remove an unrelated command entry", async () => {
    const root = temporaryDirectory("codexc-source-uninstall-unsafe-");
    const installRoot = join(root, ".codex-connect");
    const checkout = join(installRoot, "codex-channels");
    const launcher = join(installRoot, ".bin", "codexc");
    runGit(root, ["init", "--quiet", checkout]);
    mkdirSync(resolve(launcher, ".."), { recursive: true });
    writeFileSync(launcher, "#!/bin/sh\nexec unrelated-command\n");
    let serviceUninstalls = 0;

    await expect(uninstallManagedSourceInstallation(
      { ...process.env, CODEX_CONNECT_HOME: installRoot },
      {
        projectDir: checkout,
        uninstallServices: () => { serviceUninstalls += 1; },
      },
    )).rejects.toThrow("命令入口不属于当前源码安装");

    expect(serviceUninstalls).toBe(0);
    expect(existsSync(checkout)).toBe(true);
    expect(readFileSync(launcher, "utf8")).toContain("unrelated-command");
  });

  it("removes the legacy visible source launcher", async () => {
    const root = temporaryDirectory("codexc-source-uninstall-legacy-");
    const installRoot = join(root, ".codex-connect");
    const checkout = join(installRoot, "codex-channels");
    const legacyLauncher = join(installRoot, "bin", "codexc");
    const globalPackage = join(root, "npm-global", "@hegenai", "codexc");
    runGit(root, ["init", "--quiet", checkout]);
    mkdirSync(resolve(legacyLauncher, ".."), { recursive: true });
    mkdirSync(globalPackage, { recursive: true });
    writeFileSync(
      legacyLauncher,
      `#!/bin/sh\nexec node "${checkout}/bin/codexc.mjs" "$@"\n`,
    );

    await uninstallManagedSourceInstallation(
      { ...process.env, CODEX_CONNECT_HOME: installRoot },
      {
        projectDir: globalPackage,
        uninstallGlobalPackage: () => undefined,
        uninstallServices: () => undefined,
      },
    );

    expect(existsSync(checkout)).toBe(false);
    expect(existsSync(legacyLauncher)).toBe(false);
    expect(existsSync(join(installRoot, "bin"))).toBe(false);
  });

  it("allows the installed global package to uninstall its marked source checkout", async () => {
    const root = temporaryDirectory("codexc-source-uninstall-global-");
    const installRoot = join(root, ".codex-connect");
    const checkout = join(installRoot, "codex-channels");
    const globalPackage = join(root, "npm-global", "@hegenai", "codexc");
    mkdirSync(checkout, { recursive: true });
    mkdirSync(globalPackage, { recursive: true });
    runGit(checkout, ["init", "--quiet"]);
    runGit(checkout, ["config", "--local", "codex-connect.managed-source", "true"]);
    let globalUninstalls = 0;

    await uninstallManagedSourceInstallation(
      { ...process.env, CODEX_CONNECT_HOME: installRoot },
      {
        projectDir: globalPackage,
        uninstallGlobalPackage: () => { globalUninstalls += 1; },
        uninstallServices: () => undefined,
      },
    );

    expect(globalUninstalls).toBe(1);
    expect(existsSync(checkout)).toBe(false);
  });

  it("recognizes a clean official legacy checkout and uninstalls the active package prefix", async () => {
    const root = temporaryDirectory("codexc-source-uninstall-official-legacy-");
    const installRoot = join(root, ".codex-connect");
    const checkout = join(installRoot, "codex-channels");
    const globalPrefix = join(root, "homebrew");
    const globalPackage = join(
      globalPrefix,
      "lib",
      "node_modules",
      "@hegenai",
      "codexc",
    );
    mkdirSync(globalPackage, { recursive: true });
    writeFileSync(join(globalPackage, "package.json"), JSON.stringify({
      name: "@hegenai/codexc",
      version: "0.147.0",
    }));
    runGit(root, ["init", "--quiet", checkout]);
    runGit(checkout, ["branch", "-M", "main"]);
    runGit(checkout, ["config", "user.email", "source-uninstall@example.invalid"]);
    runGit(checkout, ["config", "user.name", "Source Uninstall Test"]);
    runGit(checkout, [
      "remote",
      "add",
      "origin",
      "https://github.com/msola-ht/codex-channels.git",
    ]);
    writeFileSync(join(checkout, "package.json"), JSON.stringify({
      name: "@hegenai/codexc",
      version: "0.147.0",
    }));
    runGit(checkout, ["add", "."]);
    runGit(checkout, ["commit", "--quiet", "-m", "fixture"]);
    const removedPrefixes: string[][] = [];

    await uninstallManagedSourceInstallation(
      { ...process.env, CODEX_CONNECT_HOME: installRoot },
      {
        projectDir: globalPackage,
        uninstallGlobalPackage: (prefixes) => { removedPrefixes.push(prefixes); },
        uninstallServices: () => undefined,
      },
    );

    expect(removedPrefixes).toEqual([[globalPrefix]]);
    expect(existsSync(checkout)).toBe(false);
  });

  it("uses the active package prefix instead of the current npm global prefix", async () => {
    const root = temporaryDirectory("codexc-source-uninstall-other-prefix-");
    const installRoot = join(root, ".codex-connect");
    const checkout = join(installRoot, "codex-channels");
    const globalPrefix = join(root, "homebrew");
    const globalPackage = join(
      globalPrefix,
      "lib",
      "node_modules",
      "@hegenai",
      "codexc",
    );
    const globalLauncher = join(globalPrefix, "bin", "codexc");
    runGit(root, ["init", "--quiet", checkout]);
    runGit(checkout, ["config", "--local", "codex-connect.managed-source", "true"]);
    mkdirSync(join(globalPackage, "bin"), { recursive: true });
    mkdirSync(resolve(globalLauncher, ".."), { recursive: true });
    writeFileSync(join(globalPackage, "package.json"), JSON.stringify({
      name: "@hegenai/codexc",
      version: "0.147.0",
      bin: { codexc: "bin/codexc.mjs" },
    }));
    writeFileSync(join(globalPackage, "bin", "codexc.mjs"), "#!/usr/bin/env node\n");
    symlinkSync(join(globalPackage, "bin", "codexc.mjs"), globalLauncher);

    await uninstallManagedSourceInstallation(
      { ...process.env, CODEX_CONNECT_HOME: installRoot },
      {
        projectDir: globalPackage,
        uninstallServices: () => undefined,
      },
    );

    expect(existsSync(globalPackage)).toBe(false);
    expect(existsSync(globalLauncher)).toBe(false);
    expect(existsSync(checkout)).toBe(false);
  });

  it("refuses to remove a dirty unmarked legacy checkout", async () => {
    const root = temporaryDirectory("codexc-source-uninstall-dirty-legacy-");
    const installRoot = join(root, ".codex-connect");
    const checkout = join(installRoot, "codex-channels");
    const globalPackage = join(
      root,
      "homebrew",
      "lib",
      "node_modules",
      "@hegenai",
      "codexc",
    );
    mkdirSync(globalPackage, { recursive: true });
    runGit(root, ["init", "--quiet", checkout]);
    runGit(checkout, ["branch", "-M", "main"]);
    runGit(checkout, ["config", "user.email", "source-uninstall@example.invalid"]);
    runGit(checkout, ["config", "user.name", "Source Uninstall Test"]);
    runGit(checkout, [
      "remote",
      "add",
      "origin",
      "https://github.com/msola-ht/codex-channels.git",
    ]);
    writeFileSync(join(checkout, "package.json"), JSON.stringify({
      name: "@hegenai/codexc",
      version: "0.147.0",
    }));
    runGit(checkout, ["add", "."]);
    runGit(checkout, ["commit", "--quiet", "-m", "fixture"]);
    writeFileSync(join(checkout, "local-change.txt"), "keep me");

    await expect(uninstallManagedSourceInstallation(
      { ...process.env, CODEX_CONNECT_HOME: installRoot },
      {
        projectDir: globalPackage,
        uninstallGlobalPackage: () => undefined,
        uninstallServices: () => undefined,
      },
    )).rejects.toThrow("存在未提交修改");

    expect(existsSync(join(checkout, "local-change.txt"))).toBe(true);
  });
});

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function createFixtureRepository(
  root: string,
  options: { failBuild?: boolean; gatewayVersion?: string } = {},
): string {
  const repository = join(root, "repository");
  const gatewayVersion = options.gatewayVersion ?? "0.147.0";
  mkdirSync(join(repository, "bin"), { recursive: true });
  mkdirSync(join(repository, "scripts"), { recursive: true });
  mkdirSync(join(repository, "src", "codex-protocol"), { recursive: true });
  mkdirSync(join(repository, "webui"), { recursive: true });
  writeFileSync(join(repository, "package.json"), JSON.stringify({
    name: "@hegenai/codexc",
    version: gatewayVersion,
    type: "module",
    bin: { codexc: "bin/codexc.mjs" },
    scripts: {
      build: "node scripts/build.mjs",
      check: "node scripts/check.mjs",
    },
  }));
  writeFileSync(
    join(repository, "src", "codex-protocol", "version.json"),
    JSON.stringify({ codexCli: "codex-cli 0.147.0" }),
  );
  writeFileSync(join(repository, "package-lock.json"), fixtureLock("@hegenai/codexc"));
  writeFileSync(
    join(repository, "bin", "codexc.mjs"),
    `#!/usr/bin/env node\nconsole.log('${gatewayVersion}');\n`,
  );
  writeFileSync(
    join(repository, "scripts", "build.mjs"),
    options.failBuild
      ? "process.exit(1);\n"
      : "import { mkdirSync, writeFileSync } from 'node:fs';\n"
        + "mkdirSync('dist', { recursive: true });\n"
        + "writeFileSync('dist/main.js', '');\n",
  );
  writeFileSync(join(repository, "scripts", "check.mjs"), "\n");
  copyFileSync(
    resolve("scripts/source-shell-path.mjs"),
    join(repository, "scripts", "source-shell-path.mjs"),
  );
  writeFileSync(join(repository, "webui", "package.json"), JSON.stringify({
    name: "codexc-webui-fixture",
    version: "0.147.0",
    type: "module",
    scripts: { build: "node build.mjs" },
  }));
  writeFileSync(
    join(repository, "webui", "package-lock.json"),
    fixtureLock("codexc-webui-fixture"),
  );
  writeFileSync(
    join(repository, "webui", "build.mjs"),
    "import { mkdirSync, writeFileSync } from 'node:fs';\n"
      + "mkdirSync('dist', { recursive: true });\n"
      + "writeFileSync('dist/index.html', '');\n",
  );
  runGit(repository, ["init", "--quiet"]);
  runGit(repository, ["branch", "-M", "main"]);
  runGit(repository, ["config", "user.email", "source-install@example.invalid"]);
  runGit(repository, ["config", "user.name", "Source Install Test"]);
  runGit(repository, ["add", "."]);
  runGit(repository, ["commit", "--quiet", "-m", "fixture"]);
  return repository;
}

function runInstaller(
  root: string,
  repository: string,
  home: string,
  options: { codexInstalled?: boolean; shell?: string } = {},
) {
  const fakeBin = join(root, "fake-bin");
  mkdirSync(fakeBin, { recursive: true });
  const codex = join(fakeBin, "codex");
  if (options.codexInstalled !== false) {
    writeFileSync(codex, fakeCodexScript(true));
    chmodSync(codex, 0o755);
  } else {
    symlinkSync(process.execPath, join(fakeBin, "node"));
    const realNpm = execFileSync("which", ["npm"], { encoding: "utf8" }).trim();
    const npm = join(fakeBin, "npm");
    writeFileSync(
      npm,
      `#!${process.execPath}\n`
        + "import { chmodSync, writeFileSync } from 'node:fs';\n"
        + "import { spawnSync } from 'node:child_process';\n"
        + "const args = process.argv.slice(2);\n"
        + `if (args.includes('@openai/codex@0.147.0')) {\n`
        + `  writeFileSync(${JSON.stringify(codex)}, ${JSON.stringify(fakeCodexScript(false))});\n`
        + `  chmodSync(${JSON.stringify(codex)}, 0o755);\n`
        + "  process.exit(0);\n"
        + "}\n"
        + `const result = spawnSync(${JSON.stringify(realNpm)}, args, { env: process.env, stdio: 'inherit' });\n`
        + "if (result.error) throw result.error;\n"
        + "process.exit(result.status ?? 1);\n",
    );
    chmodSync(npm, 0o755);
  }
  const inheritedPath = options.codexInstalled === false
    ? "/usr/bin:/bin"
    : process.env.PATH ?? "";
  const npmGlobalBin = join(root, "npm-global", "bin");

  return spawnSync(
    "/bin/sh",
    [resolve("install.sh")],
    {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        CODEX_CONNECT_CONFIG_FILE: "",
        CODEX_CONNECT_HOME: join(home, ".codex-connect"),
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: `url.${repository}.insteadOf`,
        GIT_CONFIG_VALUE_0: "https://github.com/msola-ht/codex-channels.git",
        HOME: home,
        npm_config_prefix: join(root, "npm-global"),
        PATH: `${fakeBin}${delimiter}${npmGlobalBin}${delimiter}${inheritedPath}`,
        SHELL: options.shell ?? "/bin/sh",
      },
    },
  );
}

function fakeCodexScript(loggedIn: boolean): string {
  return "#!/bin/sh\n"
    + "if [ \"${1:-}\" = '--version' ]; then printf '%s\\n' 'codex-cli 0.147.0'; exit 0; fi\n"
    + "if [ \"${1:-}\" = 'login' ] && [ \"${2:-}\" = 'status' ]; then "
    + `exit ${loggedIn ? 0 : 1}; fi\n`
    + "exit 1\n";
}

function fixtureLock(name: string): string {
  return JSON.stringify({
    name,
    version: "0.147.0",
    lockfileVersion: 3,
    requires: true,
    packages: { "": { name, version: "0.147.0" } },
  });
}

function runGit(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}
