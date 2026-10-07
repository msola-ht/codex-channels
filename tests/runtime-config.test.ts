import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { initializeUserData, locateOptionalUserConfig, requireUserConfig } from "../scripts/runtime-config.mjs";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("runtime config location", () => {
  it("returns undefined only when the config file does not exist", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-connect-runtime-config-"));
    temporaryDirectories.push(root);

    expect(locateOptionalUserConfig({ CODEX_CONNECT_HOME: root })).toBeUndefined();
  });

  it("does not treat an invalid configured path as an absent config", () => {
    expect(() => locateOptionalUserConfig({ CODEX_CONNECT_CONFIG_FILE: "\0" }))
      .toThrow();
  });

  it("does not ignore an explicitly configured missing file", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-connect-runtime-config-"));
    temporaryDirectories.push(root);
    const configPath = join(root, "missing.toml");

    expect(() => locateOptionalUserConfig({ CODEX_CONNECT_CONFIG_FILE: configPath }))
      .toThrow(configPath);
  });

  it("rejects a symbolic link before preparing a user config", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-connect-runtime-config-link-"));
    temporaryDirectories.push(root);
    const targetPath = join(root, "target.toml");
    const configPath = join(root, "config.toml");
    writeFileSync(targetPath, "version = 1\n", { mode: 0o600 });
    symlinkSync(targetPath, configPath);

    expect(() => requireUserConfig({ CODEX_CONNECT_CONFIG_FILE: configPath }))
      .toThrow("config.toml 必须是普通文件且不能是符号链接");
  });
});

describe("user data initialization", () => {
  function createFixture() {
    const root = mkdtempSync(join(tmpdir(), "codex-connect-init-git-"));
    temporaryDirectories.push(root);
    const dataDir = join(root, ".codex-connect");
    const workspace = join(dataDir, "workspace");
    const environment = {
      ...process.env,
      HOME: root,
      USERPROFILE: root,
      XDG_CONFIG_HOME: root,
      CODEX_CONNECT_HOME: dataDir,
      CODEX_CONNECT_CONFIG_FILE: "",
    };
    return { root, dataDir, workspace, environment };
  }

  function git(cwd: string, environment: NodeJS.ProcessEnv, ...args: string[]) {
    return execFileSync("git", args, { cwd, env: environment, encoding: "utf8" }).trim();
  }

  it("creates a Git repository in the default workspace without a commit", () => {
    const fixture = createFixture();
    const result = initializeUserData({ environment: fixture.environment, cwd: fixture.root });

    expect(result.created).toBe(true);
    expect(result.workspace).toBe(realpathSync(fixture.workspace));
    expect(existsSync(result.configPath)).toBe(true);
    expect(git(fixture.workspace, fixture.environment, "rev-parse", "--show-toplevel"))
      .toBe(result.workspace);
    expect(git(fixture.workspace, fixture.environment, "status", "--porcelain")).toBe("");
    expect(spawnSync("git", ["rev-parse", "--verify", "HEAD"], {
      cwd: fixture.workspace,
      env: fixture.environment,
    }).status).toBe(128);
    expect(existsSync(join(fixture.root, ".git"))).toBe(false);

    const before = readFileSync(result.configPath, "utf8");
    git(fixture.workspace, fixture.environment, "config", "--local", "fixture.marker", "preserved");
    expect(initializeUserData({ environment: fixture.environment, cwd: fixture.root }).created)
      .toBe(false);
    expect(readFileSync(result.configPath, "utf8")).toBe(before);
    expect(git(fixture.workspace, fixture.environment, "config", "--local", "--get", "fixture.marker"))
      .toBe("preserved");
  });

  it.each(["directory", "file"])("preserves an existing .git %s when creating the config", (kind) => {
    const fixture = createFixture();
    mkdirSync(fixture.workspace, { recursive: true });
    const initArgs = kind === "file" ? ["--separate-git-dir", join(fixture.root, "repository")] : [];
    git(fixture.workspace, fixture.environment, "init", "--quiet", ...initArgs);
    git(fixture.workspace, fixture.environment, "config", "--local", "fixture.marker", "preserved");
    writeFileSync(join(fixture.workspace, "existing.txt"), "existing work\n");

    initializeUserData({ environment: { ...fixture.environment, PATH: "" }, cwd: fixture.root });

    expect(git(fixture.workspace, fixture.environment, "config", "--local", "--get", "fixture.marker"))
      .toBe("preserved");
    expect(readFileSync(join(fixture.workspace, "existing.txt"), "utf8")).toBe("existing work\n");
  });

  it("does not add a repository to an existing user configuration", () => {
    const fixture = createFixture();
    mkdirSync(fixture.workspace, { recursive: true, mode: 0o700 });
    const configPath = join(fixture.dataDir, "config.toml");
    writeFileSync(configPath, "version = 1\n", { mode: 0o600 });

    expect(initializeUserData({ environment: { ...fixture.environment, PATH: "" }, cwd: fixture.root }).created)
      .toBe(false);
    expect(existsSync(join(fixture.workspace, ".git"))).toBe(false);
    expect(readFileSync(configPath, "utf8")).toBe("version = 1\n");
  });

  it("ignores Git environment overrides that target another repository", () => {
    const fixture = createFixture();
    const otherRepository = join(fixture.root, "other-repository");
    const otherWorkspace = join(fixture.root, "other-workspace");
    mkdirSync(otherWorkspace);

    initializeUserData({
      environment: {
        ...fixture.environment,
        GIT_DIR: otherRepository,
        GIT_WORK_TREE: otherWorkspace,
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "core.bare",
        GIT_CONFIG_VALUE_0: "true",
      },
      cwd: fixture.root,
    });

    expect(git(fixture.workspace, fixture.environment, "rev-parse", "--show-toplevel"))
      .toBe(realpathSync(fixture.workspace));
    expect(existsSync(otherRepository)).toBe(false);
    expect(existsSync(join(otherWorkspace, ".git"))).toBe(false);
  });

  it("fails without writing config when Git is unavailable, and allows retry", () => {
    const fixture = createFixture();

    expect(() => initializeUserData({ environment: { ...fixture.environment, PATH: "" }, cwd: fixture.root }))
      .toThrow("Git 不可用");
    expect(existsSync(join(fixture.dataDir, "config.toml"))).toBe(false);

    expect(initializeUserData({ environment: fixture.environment, cwd: fixture.root }).created)
      .toBe(true);
    expect(existsSync(join(fixture.workspace, ".git"))).toBe(true);
  });

  it("reports git init failure without writing config", () => {
    const fixture = createFixture();
    writeFileSync(join(fixture.root, ".gitconfig"), "[invalid config\n");

    expect(() => initializeUserData({ environment: fixture.environment, cwd: fixture.root }))
      .toThrow("git init 失败");
    expect(existsSync(join(fixture.dataDir, "config.toml"))).toBe(false);
  });

  it("allows retry after Git partially initializes a repository with an invalid default branch", () => {
    const fixture = createFixture();
    const globalConfig = join(fixture.root, ".gitconfig");
    mkdirSync(fixture.workspace, { recursive: true });
    writeFileSync(join(fixture.workspace, "existing.txt"), "existing work\n");
    writeFileSync(globalConfig, "[init]\n\tdefaultBranch = invalid..branch\n");

    expect(() => initializeUserData({ environment: fixture.environment, cwd: fixture.root }))
      .toThrow("git init 失败");
    expect(existsSync(join(fixture.dataDir, "config.toml"))).toBe(false);
    expect(existsSync(join(fixture.workspace, ".git"))).toBe(false);
    expect(readFileSync(join(fixture.workspace, "existing.txt"), "utf8")).toBe("existing work\n");

    writeFileSync(globalConfig, "[init]\n\tdefaultBranch = main\n");
    const result = initializeUserData({ environment: fixture.environment, cwd: fixture.root });

    expect(result.created).toBe(true);
    expect(existsSync(result.configPath)).toBe(true);
    expect(git(fixture.workspace, fixture.environment, "rev-parse", "--show-toplevel"))
      .toBe(realpathSync(fixture.workspace));
    expect(git(fixture.workspace, fixture.environment, "symbolic-ref", "HEAD")).toBe("refs/heads/main");
    expect(git(fixture.workspace, fixture.environment, "status", "--porcelain"))
      .toBe("?? existing.txt");
  });
});
