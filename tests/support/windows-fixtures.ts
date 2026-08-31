import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  securePrivateDirectorySync,
  securePrivateFileSync,
} from "../../runtime/private-file.mjs";

/**
 * Applies the platform's private-directory contract to a test fixture.
 * Windows requires an ACL rewrite; Unix keeps the explicit mode bits.
 */
export function secureTestDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if (process.platform === "win32") {
    securePrivateDirectorySync(path);
  } else {
    chmodSync(path, 0o700);
  }
}

/** Applies the platform's private-file contract to a test fixture. */
export function secureTestFile(path: string, content = ""): void {
  writeFileSync(path, content, { mode: 0o600 });
  if (process.platform === "win32") {
    securePrivateFileSync(path);
  } else {
    chmodSync(path, 0o600);
  }
}

/**
 * Writes a fake Codex executable that can be launched by the platform.
 * JavaScript files are intentionally retained as the implementation body;
 * runtime executable resolution supplies Node on Windows.
 */
export function writeFakeCodex(root: string, body: string): string {
  const path = join(root, "fake-codex.mjs");
  writeFileSync(path, body, { mode: 0o700 });
  if (process.platform !== "win32") {
    chmodSync(path, 0o700);
  }
  return path;
}
