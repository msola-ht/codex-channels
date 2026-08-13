import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  writePrivateFileAtomic,
  writePrivateFileAtomicSync,
} from "../runtime/private-file.mjs";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("private atomic files", () => {
  it("creates private parents and atomically replaces a synchronous file", () => {
    const root = createRoot();
    const path = join(root, "codex-home", "profile.toml");

    writePrivateFileAtomicSync(path, "first\n");
    chmodSync(path, 0o644);
    writePrivateFileAtomicSync(path, "second\n");

    expect(readFileSync(path, "utf8")).toBe("second\n");
    expect(statSync(join(root, "codex-home")).mode & 0o777).toBe(0o700);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readdirSync(join(root, "codex-home"))).toEqual(["profile.toml"]);
  });

  it("creates private parents and atomically replaces an asynchronous file", async () => {
    const root = createRoot();
    const path = join(root, "codex-home", "models.json");

    await writePrivateFileAtomic(path, Buffer.from("first\n"));
    await writePrivateFileAtomic(path, "second\n");

    expect(readFileSync(path, "utf8")).toBe("second\n");
    expect(statSync(join(root, "codex-home")).mode & 0o777).toBe(0o700);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readdirSync(join(root, "codex-home"))).toEqual(["models.json"]);
    expect(existsSync(`${path}.tmp`)).toBe(false);
  });
});

function createRoot() {
  const root = mkdtempSync(join(tmpdir(), "codexc-private-file-"));
  temporaryDirectories.push(root);
  return root;
}
