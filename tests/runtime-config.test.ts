import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { locateOptionalUserConfig } from "../scripts/runtime-config.mjs";

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
});
