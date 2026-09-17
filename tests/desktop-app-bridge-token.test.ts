import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  desktopAppBridgeTokenPath,
  loadOrCreateDesktopAppBridgeToken,
} from "../runtime/desktop-app-bridge.mjs";

describe("Codex Desktop App bridge token", () => {
  it("creates and reuses a private bridge token", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "codexc-desktop-token-"));
    try {
      const first = loadOrCreateDesktopAppBridgeToken(dataDir);
      const second = loadOrCreateDesktopAppBridgeToken(dataDir);
      const path = desktopAppBridgeTokenPath(dataDir);

      expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/u);
      expect(second).toBe(first);
      expect(readFileSync(path, "utf8")).toBe(first);
      if (process.platform !== "win32") {
        expect(statSync(path).mode & 0o777).toBe(0o600);
      }
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
