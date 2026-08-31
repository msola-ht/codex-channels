import {
  mkdtempSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { readPrivateFileSync } from "../runtime/private-file.mjs";
import { secureTestDirectory, secureTestFile } from "./support/windows-fixtures.js";

describe("private file", () => {
  it("reads a private regular file without following a symbolic link", () => {
    const directory = mkdtempSync(join(tmpdir(), "codexc-private-file-"));
    const target = join(directory, "target.txt");
    const link = join(directory, "link.txt");
    secureTestDirectory(directory);
    secureTestFile(target, "secret");
    symlinkSync(target, link);

    expect(readPrivateFileSync(target, 32)).toBe("secret");
    expect(() => readPrivateFileSync(link)).toThrow();
  });
});
