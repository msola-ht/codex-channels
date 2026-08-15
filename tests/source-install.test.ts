import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
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

  it("clones main under .codex-connect and creates a stable launcher", () => {
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
    const launcher = join(installRoot, "bin", "codexc");
    expect(existsSync(join(checkout, ".git"))).toBe(true);
    expect(existsSync(join(checkout, "dist", "main.js"))).toBe(true);
    expect(existsSync(join(checkout, "webui", "dist", "index.html"))).toBe(true);
    expect(readFileSync(launcher, "utf8")).toContain("codex-channels/bin/codexc.mjs");
    expect(execFileSync(launcher, ["--version"], {
      encoding: "utf8",
      env: { ...process.env, HOME: home },
    }).trim()).toBe("0.147.0");
    expect(readFileSync(join(home, ".profile"), "utf8")).toContain(
      '$HOME/.codex-connect/bin',
    );
  });

  it("removes the partial checkout and launcher when the build fails", () => {
    const root = temporaryDirectory("codexc-source-install-failure-");
    const repository = createFixtureRepository(root, { failBuild: true });
    const home = join(root, "home");

    const result = runInstaller(root, repository, home);

    expect(result.status).not.toBe(0);
    expect(existsSync(join(home, ".codex-connect", "codex-channels"))).toBe(false);
    expect(existsSync(join(home, ".codex-connect", "bin", "codexc"))).toBe(false);
  });

  it("reports an existing global npm installation without removing it", () => {
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
    expect(result.stdout).toContain(
      "检测到 npm 全局版 @hegenai/codexc@0.146.1；不会自动卸载",
    );
    expect(readFileSync(npmManifest, "utf8")).toContain("0.146.1");
  });

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
  });
});

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function createFixtureRepository(
  root: string,
  options: { failBuild?: boolean } = {},
): string {
  const repository = join(root, "repository");
  mkdirSync(join(repository, "bin"), { recursive: true });
  mkdirSync(join(repository, "scripts"), { recursive: true });
  mkdirSync(join(repository, "webui"), { recursive: true });
  writeFileSync(join(repository, "package.json"), JSON.stringify({
    name: "@hegenai/codexc",
    version: "0.147.0",
    type: "module",
    scripts: {
      build: "node scripts/build.mjs",
      check: "node scripts/check.mjs",
    },
  }));
  writeFileSync(join(repository, "package-lock.json"), fixtureLock("@hegenai/codexc"));
  writeFileSync(
    join(repository, "bin", "codexc.mjs"),
    "#!/usr/bin/env node\nconsole.log('0.147.0');\n",
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
  options: { codexInstalled?: boolean } = {},
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
        PATH: `${fakeBin}${delimiter}${inheritedPath}`,
        SHELL: "/bin/sh",
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
