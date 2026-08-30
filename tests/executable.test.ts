import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  executableInvocation,
  resolveExecutable,
  resolveOptionalExecutable,
} from "../runtime/executable.mjs";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("executable resolver", () => {
  it("resolves a named executable from the supplied PATH", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-connect-executable-"));
    temporaryDirectories.push(root);
    const binDirectory = join(root, "bin");
    const executable = join(
      binDirectory,
      process.platform === "win32" ? "custom-codex.EXE" : "custom-codex",
    );
    mkdirSync(binDirectory);
    writeFileSync(executable, "#!/bin/sh\nexit 0\n");
    chmodSync(executable, 0o700);

    expect(resolveExecutable("custom-codex", { PATH: binDirectory }))
      .toBe(realpathSync(executable));
  });

  it("returns undefined when an optional executable is unavailable", () => {
    expect(resolveOptionalExecutable("missing-command", { PATH: "" })).toBeUndefined();
  });

  it.runIf(process.platform === "win32")(
    "resolves PATHEXT shims from a Windows PATH containing spaces",
    () => {
      const root = mkdtempSync(join(tmpdir(), "codex connect executable "));
      temporaryDirectories.push(root);
      const executable = join(root, "custom-codex.CMD");
      writeFileSync(executable, "@echo off\r\nexit /b 0\r\n");

      expect(resolveExecutable("custom-codex", {
        PATH: root,
        PATHEXT: ".EXE;.CMD;.BAT",
      })).toBe(realpathSync(executable));
      expect(resolveExecutable(executable, {
        PATH: "",
        PATHEXT: ".EXE;.CMD;.BAT",
      })).toBe(realpathSync(executable));
    },
  );

  it.runIf(process.platform === "win32")(
    "runs a resolved batch shim through the configured command interpreter",
    () => {
      const root = mkdtempSync(join(tmpdir(), "codex connect batch "));
      temporaryDirectories.push(root);
      const executable = join(root, "custom-codex.cmd");
      writeFileSync(executable, [
        "@echo off",
        'if "%~1"=="value with spaces" exit /b 0',
        "exit /b 7",
        "",
      ].join("\r\n"));
      const invocation = executableInvocation(executable, ["value with spaces"]);
      const result = spawnSync(invocation.file, invocation.args, {
        windowsVerbatimArguments: invocation.windowsVerbatimArguments,
      });

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
    },
  );
});
