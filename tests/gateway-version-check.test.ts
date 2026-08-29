import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

describe("Gateway version check", () => {
  it.each([
    ["0.148.0", true],
    ["0.148.0-fix1", true],
    ["0.148.0-fix2", true],
    ["0.148.0-rc.1", true],
    ["0.148.0-rc.2", true],
    ["0.148.0-fix0", false],
    ["0.148.0-rc.0", false],
    ["0.148.0-alpha.1", false],
    ["0.149.0-fix1", false],
  ])("validates %s against the locked Codex CLI", (version, accepted) => {
    const fixture = mkdtempSync(join(tmpdir(), "codexc-version-check-"));
    const scriptsDirectory = join(fixture, "scripts");
    const protocolDirectory = join(fixture, "src", "codex-protocol");
    mkdirSync(scriptsDirectory);
    mkdirSync(protocolDirectory, { recursive: true });
    try {
      copyFileSync(
        resolve("scripts", "check-gateway-version.mjs"),
        join(scriptsDirectory, "check-gateway-version.mjs"),
      );
      writeFileSync(join(fixture, "package.json"), JSON.stringify({ version }));
      writeFileSync(
        join(fixture, "src", "version.json"),
        JSON.stringify({ version }),
      );
      writeFileSync(
        join(protocolDirectory, "version.json"),
        JSON.stringify({ codexCli: "codex-cli 0.148.0" }),
      );

      const result = spawnSync(
        process.execPath,
        [join(scriptsDirectory, "check-gateway-version.mjs")],
        { cwd: fixture, encoding: "utf8" },
      );

      expect(result.status, result.stderr).toBe(accepted ? 0 : 1);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it("rejects different npm and runtime versions", () => {
    const fixture = mkdtempSync(join(tmpdir(), "codexc-version-mismatch-"));
    const scriptsDirectory = join(fixture, "scripts");
    const protocolDirectory = join(fixture, "src", "codex-protocol");
    mkdirSync(scriptsDirectory);
    mkdirSync(protocolDirectory, { recursive: true });
    try {
      copyFileSync(
        resolve("scripts", "check-gateway-version.mjs"),
        join(scriptsDirectory, "check-gateway-version.mjs"),
      );
      writeFileSync(
        join(fixture, "package.json"),
        JSON.stringify({ version: "0.148.0-fix1" }),
      );
      writeFileSync(
        join(fixture, "src", "version.json"),
        JSON.stringify({ version: "0.148.0" }),
      );
      writeFileSync(
        join(protocolDirectory, "version.json"),
        JSON.stringify({ codexCli: "codex-cli 0.148.0" }),
      );

      const result = spawnSync(
        process.execPath,
        [join(scriptsDirectory, "check-gateway-version.mjs")],
        { cwd: fixture, encoding: "utf8" },
      );

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("npm 包与 Gateway 运行时版本不一致");
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});
