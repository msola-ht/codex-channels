import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { locateOptionalUserConfig, requireUserConfig } from "../scripts/runtime-config.mjs";

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
