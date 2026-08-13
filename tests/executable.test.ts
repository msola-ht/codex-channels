import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
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
    const executable = join(binDirectory, "custom-codex");
    mkdirSync(binDirectory);
    writeFileSync(executable, "#!/bin/sh\nexit 0\n");
    chmodSync(executable, 0o700);

    expect(resolveExecutable("custom-codex", { PATH: binDirectory }))
      .toBe(realpathSync(executable));
  });

  it("returns undefined when an optional executable is unavailable", () => {
    expect(resolveOptionalExecutable("missing-command", { PATH: "" })).toBeUndefined();
  });
});
