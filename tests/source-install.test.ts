import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
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
  it("clones main under .codex-connect and creates a stable launcher", () => {
    const root = temporaryDirectory("codexc-source-install-");
    const repository = createFixtureRepository(root);
    const home = join(root, "home");
    const result = runInstaller(root, repository, home);

    expect(result.status, result.stderr || result.stdout).toBe(0);
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

function runInstaller(root: string, repository: string, home: string) {
  const fakeBin = join(root, "fake-bin");
  mkdirSync(fakeBin, { recursive: true });
  const codex = join(fakeBin, "codex");
  writeFileSync(codex, "#!/bin/sh\nprintf '%s\\n' 'codex-cli 0.147.0'\n");
  chmodSync(codex, 0o755);

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
        PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ""}`,
        SHELL: "/bin/sh",
      },
    },
  );
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
