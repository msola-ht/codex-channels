import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  isOpencodeGoProvider,
  loadOpencodeGoAccounts,
  loadOpencodeGoDefaultAccount,
  opencodeGoAccountIdFromProvider,
  opencodeGoAccountMarkerPath,
  opencodeGoApiKeyEnvironmentKey,
  opencodeGoProviderId,
  readOpencodeGoAccountMarker,
  sharedProviderProxyKey,
  validateOpencodeGoAccountId,
  writeOpencodeGoAccountMarker,
  writeOpencodeGoAccounts,
  opencodeGoAccountDisplayName,
  loadOpencodeGoProviderIdentities,
  validateOpencodeGoContact,
} from "../runtime/opencode-go-accounts.mjs";

describe("OpenCode Go account registry", () => {
  it("validates account ids and derives provider ids", () => {
    expect(opencodeGoProviderId("main")).toBe("ocg-main");
    expect(opencodeGoProviderId("opencode-go")).toBe("ocg-opencode-go");
    expect(opencodeGoProviderId("b-2")).toBe("ocg-b-2");
    expect(opencodeGoAccountIdFromProvider("opencode-go")).toBeUndefined();
    expect(opencodeGoAccountIdFromProvider("ocg-main")).toBe("main");
    expect(opencodeGoAccountIdFromProvider("ocg-b-2")).toBe("b-2");
    expect(opencodeGoAccountIdFromProvider("ocg-")).toBeUndefined();
    expect(opencodeGoAccountIdFromProvider("ocg-INVALID")).toBeUndefined();
    expect(opencodeGoAccountIdFromProvider("ocg-ocg-opencode-go")).toBe("ocg-opencode-go");
    expect(opencodeGoAccountIdFromProvider("openai")).toBeUndefined();
    expect(isOpencodeGoProvider("ocg-main")).toBe(true);
    expect(isOpencodeGoProvider("ocg-lunare")).toBe(true);
    expect(isOpencodeGoProvider("ocg-")).toBe(false);
    expect(isOpencodeGoProvider("ocg-INVALID")).toBe(false);
    expect(isOpencodeGoProvider("ocg-ocg-opencode-go")).toBe(true);
    expect(isOpencodeGoProvider("deepseek")).toBe(false);
    expect(opencodeGoApiKeyEnvironmentKey("opencode-go")).toBe(
      "CODEX_CONNECT_OPENCODE_GO_OPENCODE_GO_API_KEY",
    );
    for (const invalid of ["", "A", "a b", "a".repeat(33), "openai", "deepseek"]) {
      expect(() => validateOpencodeGoAccountId(invalid)).toThrow("账户 id");
    }
  });

  it("reuses the shared statistics proxy for every OpenCode Go account", () => {
    expect(sharedProviderProxyKey("ocg-main")).toBe("ocg");
    expect(sharedProviderProxyKey("ocg-lunare")).toBe("ocg");
    expect(sharedProviderProxyKey("deepseek")).toBe("deepseek");
    expect(sharedProviderProxyKey("openai")).toBe("openai");
  });

  it("persists the registry with a single default account", () => {
    const home = fixture();
    const environment = testEnvironment(home);
    writeOpencodeGoAccounts(environment, [
      { id: "main", default: true, email: "User@Example.com" },
      { id: "b", default: false, phone: "+1 (555) 123-4567" },
    ]);

    expect(loadOpencodeGoAccounts(environment)).toEqual([
      { id: "main", default: true, email: "user@example.com" },
      { id: "b", default: false, phone: "+15551234567" },
    ]);
    expect(opencodeGoAccountDisplayName({ id: "main", email: "user@example.com" }))
      .toBe("ocg-user@example.com");
    expect(opencodeGoAccountDisplayName({ id: "b", phone: "+15551234567" }))
      .toBe("ocg-+15551234567");
    expect(validateOpencodeGoContact(" User@Example.com "))
      .toEqual({ type: "email", value: "user@example.com" });
    expect(validateOpencodeGoContact("+1 (555) 123-4567"))
      .toEqual({ type: "phone", value: "+15551234567" });
    expect(() => validateOpencodeGoContact(""))
      .toThrow("必须提供邮箱或手机号码");
  });

  it("does not infer a default account from registry order", () => {
    const home = fixture();
    const environment = testEnvironment(home);
    writeOpencodeGoAccounts(environment, [
      { id: "work", default: false, email: "user@example.com" },
    ]);

    expect(loadOpencodeGoDefaultAccount(environment)).toBeUndefined();
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
    expect(() => writeOpencodeGoAccounts(environment, [
      { id: "a-b", default: true, email: "a@example.com" },
      { id: "a_b", default: false, email: "b@example.com" },
    ])).toThrow("API Key 环境变量名冲突");
  });

  it("writes and reads account markers in the shared provider directory", () => {
    const home = fixture();
    const environment = testEnvironment(home);
    writeOpencodeGoAccountMarker(environment, "main", "switching");

    expect(readOpencodeGoAccountMarker(environment, "main")).toEqual({
      version: 1,
      provider: "ocg-main",
      mode: "switching",
    });
    expect(existsSync(opencodeGoAccountMarkerPath(environment, "main"))).toBe(true);
    expect(readFileSync(opencodeGoAccountMarkerPath(environment, "main"), "utf8"))
      .toContain('provider = "ocg-main"');
  });

  it("exports contact identities without changing request provider ids", () => {
    const home = fixture();
    const environment = testEnvironment(home);
    writeOpencodeGoAccounts(environment, [
      { id: "main", default: true, email: "user@example.com" },
      { id: "b", default: false, phone: "+15551234567" },
    ]);

    expect(loadOpencodeGoProviderIdentities(environment)).toEqual([
      {
        provider: "ocg-main",
        displayName: "ocg-user@example.com",
        email: "user@example.com",
      },
      {
        provider: "ocg-b",
        displayName: "ocg-+15551234567",
        phone: "+15551234567",
      },
    ]);
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
