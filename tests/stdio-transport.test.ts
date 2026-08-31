import {
  chmodSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { StdioTransport } from "../src/codex-client/stdio-transport.js";
import { executableInvocation } from "../runtime/executable.mjs";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("StdioTransport", () => {
  it("passes the configured environment to the App Server process", async () => {
    const root = mkdtempSync(join(tmpdir(), "codexc-stdio-"));
    temporaryDirectories.push(root);
    const windows = process.platform === "win32";
    const executable = join(root, windows ? "fake-codex.cmd" : "fake-codex");
    writeFileSync(executable, windows
      ? [
          "@echo off",
          'set /p "=%CODEX_TEST_MARKER%" <nul 1>&2',
        ].join("\r\n")
      : [
          "#!/bin/sh",
          'printf "%s" "$CODEX_TEST_MARKER" >&2',
          "while IFS= read -r _line; do :; done",
        ].join("\n"), { mode: 0o700 });
    chmodSync(executable, 0o700);
    let stderr = "";
    const transport = new StdioTransport({
      codexBinary: executable,
      createCodexProcessInvocation: (args) => executableInvocation(executable, args),
      cwd: root,
      environment: {
        ...process.env,
        CODEX_TEST_MARKER: "isolated-codex-home",
      },
      onStderr: (text) => {
        stderr += text;
      },
    });

    try {
      await transport.connect();
      await expect.poll(() => stderr).toBe("isolated-codex-home");
    } finally {
      await transport.close();
    }
  });
});
