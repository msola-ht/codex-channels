import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  isOpencodeGoProvider,
  loadOpencodeGoAccounts,
  opencodeGoAccountIdFromProvider,
  opencodeGoAccountMarkerPath,
  opencodeGoApiKeyEnvironmentKey,
  opencodeGoProviderId,
  readOpencodeGoAccountMarker,
  sharedProviderProxyKey,
  validateOpencodeGoAccountId,
  writeOpencodeGoAccountMarker,
  writeOpencodeGoAccounts,
} from "../runtime/opencode-go-accounts.mjs";

describe("OpenCode Go account registry", () => {
  it("validates account ids and derives provider ids", () => {
    expect(opencodeGoProviderId("main")).toBe("opencode-go-main");
    expect(opencodeGoProviderId("opencode-go")).toBe("opencode-go");
    expect(opencodeGoProviderId("b-2")).toBe("opencode-go-b-2");
    expect(opencodeGoAccountIdFromProvider("opencode-go")).toBe("opencode-go");
    expect(opencodeGoAccountIdFromProvider("opencode-go-main")).toBe("main");
    expect(opencodeGoAccountIdFromProvider("opencode-go-b-2")).toBe("b-2");
    expect(opencodeGoAccountIdFromProvider("opencode-go-")).toBeUndefined();
    expect(opencodeGoAccountIdFromProvider("opencode-go-INVALID")).toBeUndefined();
    expect(opencodeGoAccountIdFromProvider("opencode-go-opencode-go")).toBeUndefined();
    expect(opencodeGoAccountIdFromProvider("openai")).toBeUndefined();
    expect(isOpencodeGoProvider("opencode-go")).toBe(true);
    expect(isOpencodeGoProvider("opencode-go-lunare")).toBe(true);
    expect(isOpencodeGoProvider("opencode-go-")).toBe(false);
    expect(isOpencodeGoProvider("opencode-go-INVALID")).toBe(false);
    expect(isOpencodeGoProvider("opencode-go-opencode-go")).toBe(false);
    expect(isOpencodeGoProvider("deepseek")).toBe(false);
    expect(opencodeGoApiKeyEnvironmentKey("main")).toBe(
      "CODEX_CONNECT_OPENCODE_GO_MAIN_API_KEY",
    );
    expect(opencodeGoApiKeyEnvironmentKey("opencode-go")).toBe(
      "CODEX_CONNECT_OPENCODE_GO_API_KEY",
    );
    for (const invalid of ["", "A", "a b", "a".repeat(33), "openai", "deepseek"]) {
      expect(() => validateOpencodeGoAccountId(invalid)).toThrow("账户 id");
    }
  });

  it("reuses the shared statistics proxy for every OpenCode Go account", () => {
    expect(sharedProviderProxyKey("opencode-go-main")).toBe("opencode-go");
    expect(sharedProviderProxyKey("opencode-go-lunare")).toBe("opencode-go");
    expect(sharedProviderProxyKey("deepseek")).toBe("deepseek");
    expect(sharedProviderProxyKey("openai")).toBe("openai");
  });

  it("persists the registry with a single default account", () => {
    const home = fixture();
    const environment = testEnvironment(home);
    writeOpencodeGoAccounts(environment, [
      { id: "main", default: true },
      { id: "b", default: false },
    ]);

    expect(loadOpencodeGoAccounts(environment)).toEqual([
      { id: "main", default: true },
      { id: "b", default: false },
    ]);
  });

  it("rejects multiple defaults and duplicate ids", () => {
    const home = fixture();
    const environment = testEnvironment(home);
    expect(() => writeOpencodeGoAccounts(environment, [
      { id: "main", default: true },
      { id: "b", default: true },
    ])).toThrow("只能有一个默认账户");
    expect(() => writeOpencodeGoAccounts(environment, [
      { id: "main", default: true },
      { id: "main", default: false },
    ])).toThrow("注册表无效");
  });

  it("writes and reads account markers in the shared provider directory", () => {
    const home = fixture();
    const environment = testEnvironment(home);
    writeOpencodeGoAccountMarker(environment, "main", "switching");

    expect(readOpencodeGoAccountMarker(environment, "main")).toEqual({
      version: 1,
      provider: "opencode-go-main",
      mode: "switching",
    });
    expect(existsSync(opencodeGoAccountMarkerPath(environment, "main"))).toBe(true);
    expect(readFileSync(opencodeGoAccountMarkerPath(environment, "main"), "utf8"))
      .toContain('provider = "opencode-go-main"');
  });
});

function fixture() {
  return mkdtempSync(join(tmpdir(), "codexc-go-accounts-"));
}

function testEnvironment(home: string) {
  return {
    ...process.env,
    CODEX_HOME: join(home, ".codex"),
    CODEX_CONNECT_HOME: join(home, ".codex-connect"),
  };
}
