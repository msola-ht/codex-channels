import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  isOpencodeGoProvider,
  loadOpencodeGoAccounts,
  opencodeGoAccountIdFromProvider,
  opencodeGoAccountMarkerPath,
  opencodeGoAccountsFilePath,
  opencodeGoApiKeyEnvironmentKey,
  opencodeGoProviderId,
  readOpencodeGoAccountMarker,
  validateOpencodeGoAccountId,
  writeOpencodeGoAccountMarker,
  writeOpencodeGoAccounts,
  opencodeGoAccountDisplayName,
  loadOpencodeGoProviderIdentities,
  validateOpencodeGoContact,
} from "../runtime/opencode-go-accounts.mjs";
import { sharedProviderProxyKey } from "../runtime/managed-provider-account-routing.mjs";

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
    expect(sharedProviderProxyKey("ds-main")).toBe("deepseek");
    expect(sharedProviderProxyKey("ccg-main")).toBe("ccg");
    expect(sharedProviderProxyKey("ccg-work")).toBe("ccg");
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

  it("requires one explicit default account", () => {
    const home = fixture();
    const environment = testEnvironment(home);
    expect(() => writeOpencodeGoAccounts(environment, [
      { id: "work", default: false, email: "user@example.com" },
    ])).toThrow("必须有一个默认账户");
  });

  it("allows only the default-repair path to read a legacy registry without a default", () => {
    const home = fixture();
    const environment = testEnvironment(home);
    const path = opencodeGoAccountsFilePath(environment);
    mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
    chmodSync(join(path, ".."), 0o700);
    writeFileSync(path, `${JSON.stringify([
      { id: "main", default: false, email: "user@example.com" },
      { id: "work", default: false, email: "work@example.com" },
    ])}\n`, { mode: 0o600 });

    expect(() => loadOpencodeGoAccounts(environment)).toThrow("必须有一个默认账户");
    expect(loadOpencodeGoAccounts(environment, { allowMissingDefault: true })).toEqual([
      { id: "main", default: false, email: "user@example.com" },
      { id: "work", default: false, email: "work@example.com" },
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
