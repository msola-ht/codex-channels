import {
  mkdtempSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  readPrivateFileSync,
  securePrivateDirectorySync,
  securePrivateFileSync,
} from "../runtime/private-file.mjs";

describe("private file", () => {
  it("reads a private regular file without following a symbolic link", () => {
    const directory = mkdtempSync(join(tmpdir(), "codexc-private-file-"));
    const target = join(directory, "target.txt");
    const link = join(directory, "link.txt");
    securePrivateDirectorySync(directory);
    writeFileSync(target, "secret", { mode: 0o600 });
    securePrivateFileSync(target);
    symlinkSync(target, link);

    expect(readPrivateFileSync(target, 32)).toBe("secret");
    expect(() => readPrivateFileSync(link)).toThrow();
  });
});
