import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { writeOpencodeGoAccounts } from "../runtime/opencode-go-accounts.mjs";
import { ccgAccountDefinition, deepseekAccountDefinition, loadManagedModelProviderDefinitions } from "../runtime/model-provider-definitions.mjs";
import { defaultCodexRemoteProfile, parseCodexRemoteOptions as parseCodexRemoteOptionsRaw } from "../scripts/codex-remote-options.mjs";
import {
  configuredHome,
  configureCcgAccounts,
  configureOpenCodeGo,
  testEnvironment,
} from "./model-provider-runtime-test-fixture.js";

const isolatedEnvironment = {
  CODEX_HOME: join(tmpdir(), "codexc-remote-options-empty-codex"),
  CODEX_CONNECT_HOME: join(tmpdir(), "codexc-remote-options-empty-connect"),
};

function parseCodexRemoteOptions(
  args: Parameters<typeof parseCodexRemoteOptionsRaw>[0],
  options: NonNullable<Parameters<typeof parseCodexRemoteOptionsRaw>[1]> = {},
) {
  return parseCodexRemoteOptionsRaw(args, { environment: isolatedEnvironment, managedProfileDefinitions: [deepseekAccountDefinition("test"), ...loadManagedModelProviderDefinitions(options.environment ?? isolatedEnvironment)], ...options });
}

describe("Codex Remote options", () => {
  it("selects the sole switching Provider without official login and rejects ambiguous defaults", async () => {
    const environment = testEnvironment(await configuredHome("switching"));
    expect(defaultCodexRemoteProfile(environment)).toBe("sf-ds-test");
    expect(parseCodexRemoteOptions([], {
      selectDefaultProfile: () => defaultCodexRemoteProfile(environment),
    }).selectedProfile).toBe("sf-ds-test");
    configureOpenCodeGo(environment.CODEX_HOME!);
    expect(() => defaultCodexRemoteProfile(environment)).toThrow("请指定 --profile");
  });

  it("selects the registered default when every switching Provider is a CCG account", () => {
    const home = mkdtempSync(join(tmpdir(), "codexc-remote-ccg-default-"));
    try {
      configureCcgAccounts(home, "work");
      expect(defaultCodexRemoteProfile(testEnvironment(home))).toBe("sf-ccg-work");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("preserves explicit profiles without resolving the unauthenticated default", () => {
    const selectDefaultProfile = () => { throw new Error("must not resolve default"); };
    expect(parseCodexRemoteOptions(["--profile", "sf-ds-test"], { selectDefaultProfile }).selectedProfile)
      .toBe("sf-ds-test");
    expect(parseCodexRemoteOptions(["--profile", "personal"], { selectDefaultProfile }).passthrough)
      .toEqual(["--profile", "personal"]);
  });

  it.each([
    [["--profile", "sf-ds-test"], "sf-ds-test"],
  ] as const)("selects a managed Provider profile from %j", (args, selectedProfile) => {
    expect(parseCodexRemoteOptions([...args])).toEqual({
      passthrough: [],
      selectedProfile,
      workspaceId: undefined,
    });
  });

  it("keeps unmanaged profiles and arguments after -- for Codex", () => {
    expect(parseCodexRemoteOptions([
      "--profile", "personal",
      "--",
      "--profile", "opencode-go",
    ])).toEqual({
      passthrough: ["--profile", "personal", "--", "--profile", "opencode-go"],
      selectedProfile: undefined,
      workspaceId: undefined,
    });
  });

  it.each([
    "custom",
    "custom-local",
    "opencode-go-local",
    "sf-personal",
  ])("keeps the unmanaged native Profile %s for Codex", (profileName) => {
    expect(parseCodexRemoteOptions(["--profile", profileName])).toEqual({
      passthrough: ["--profile", profileName],
      selectedProfile: undefined,
      workspaceId: undefined,
    });
  });

  it("selects a custom switching Profile from one supplied runtime snapshot", () => {
    expect(parseCodexRemoteOptions(
      ["--profile", "sf-custom-proxy-a"],
      {
        customSwitchingProfiles: [{
          providerId: "proxy-a",
          profileName: "sf-custom-proxy-a",
        }],
      },
    )).toEqual({
      passthrough: [],
      selectedProfile: "sf-custom-proxy-a",
      workspaceId: undefined,
    });
  });

  it.each([
    [["--profile", "proxy-a"]],
    [["--profile=proxy-a"]],
    [["-p=proxy-a"]],
    [["-pproxy-a"]],
  ])("rejects a custom Provider ID from %j", (args) => {
    expect(() => parseCodexRemoteOptions(args, {
      customSwitchingProfiles: [{
        providerId: "proxy-a",
        profileName: "sf-custom-proxy-a",
      }],
    })).toThrow("proxy-a 是 Provider ID；请使用 --profile sf-custom-proxy-a");
  });

  it.each([
    [["--profile", "sf-custom-proxy-a"]],
    [["--profile=sf-custom-proxy-a"]],
    [["-psf-custom-proxy-a"]],
  ])("selects the canonical custom Codex Profile from %j", (args) => {
    expect(parseCodexRemoteOptions(args, {
      customSwitchingProfiles: [{
        providerId: "proxy-a",
        profileName: "sf-custom-proxy-a",
      }],
    })).toEqual({
      passthrough: [],
      selectedProfile: "sf-custom-proxy-a",
      workspaceId: undefined,
    });
  });

  it.each([
    ["ds-test", "sf-ds-test"],
  ])("rejects the old managed Profile %s", (profileName, canonicalProfileName) => {
    expect(() => parseCodexRemoteOptions(["--profile", profileName], {
      customSwitchingProfiles: [],
    })).toThrow(
      `Profile ${profileName} 不是该 Provider 的规范名称；请使用 --profile ${canonicalProfileName}`,
    );
  });

  it("does not invent a legacy alias for a future managed Provider", () => {
    const managedProfileDefinitions = [{
      id: "future-provider",
      profileName: "sf-future-provider",
    }];
    expect(parseCodexRemoteOptions(["--profile", "future-provider"], {
      managedProfileDefinitions,
      customSwitchingProfiles: [],
    })).toEqual({
      passthrough: ["--profile", "future-provider"],
      selectedProfile: undefined,
      workspaceId: undefined,
    });
    expect(parseCodexRemoteOptions(["--profile", "sf-future-provider"], {
      managedProfileDefinitions,
      customSwitchingProfiles: [],
    }).selectedProfile).toBe("sf-future-provider");
  });

  it("uses one canonical Profile name for a configured OpenCode Go account", () => {
    const root = mkdtempSync(join(tmpdir(), "codexc-remote-profile-account-"));
    const environment = { ...process.env, CODEX_CONNECT_HOME: root };
    try {
      writeOpencodeGoAccounts(environment, [
        { id: "work", default: true },
        { id: "lunare", default: false },
      ]);
      expect(parseCodexRemoteOptions(["--profile", "sf-ocg-lunare"], {
        environment,
        customSwitchingProfiles: [],
      })).toEqual({
        passthrough: [],
        selectedProfile: "sf-ocg-lunare",
        workspaceId: undefined,
      });
      expect(() => parseCodexRemoteOptions(["--profile", "opencode-go-lunare"], {
        environment,
        customSwitchingProfiles: [],
      })).toThrow(
        "Profile opencode-go-lunare 不是该 Provider 的规范名称；请使用 --profile sf-ocg-lunare",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses one canonical Profile name for a configured CCG account", () => {
    const definitions = [ccgAccountDefinition("work")];
    expect(parseCodexRemoteOptions(["--profile", "sf-ccg-work"], {
      managedProfileDefinitions: definitions,
      customSwitchingProfiles: [],
    })).toEqual({
      passthrough: [],
      selectedProfile: "sf-ccg-work",
      workspaceId: undefined,
    });
    expect(() => parseCodexRemoteOptions(["--profile", "ccg-work"], {
      managedProfileDefinitions: definitions,
      customSwitchingProfiles: [],
    })).toThrow(
      "Profile ccg-work 不是该 Provider 的规范名称；请使用 --profile sf-ccg-work",
    );
  });

  it.each([
    ["sf-ocg-missing", "OpenCode Go Profile sf-ocg-missing 尚未配置"],
    ["sf-opencode-go-missing", "OpenCode Go Profile sf-opencode-go-missing 已废弃"],
    ["sf-ccg-missing", "CCG Profile sf-ccg-missing 尚未配置"],
    ["sf-ccg", "旧 CCG 单账户 Profile 已停用，请先运行 codexc ccg legacy remove 并重新添加账户"],
  ])("rejects an unconfigured project-owned Profile namespace %s", (profileName, message) => {
    expect(() => parseCodexRemoteOptions(["--profile", profileName], {
      customSwitchingProfiles: [],
    })).toThrow(message);
  });

  it.each([
    "sf-custom",
    "sf-custom-missing",
  ])("rejects an unconfigured or reserved custom Codex Profile %s", (profileName) => {
    expect(() => parseCodexRemoteOptions(["--profile", profileName], {
      customSwitchingProfiles: [],
    })).toThrow(profileName === "sf-custom"
      ? "Codex Profile sf-custom 是内部保留名称；固定模式请直接使用 codexc remote"
      : "Codex Profile sf-custom-missing 尚未配置；请先运行 codexc setup 配置对应 Provider");
  });

  it.each([
    [{ providerId: "proxy-a", profileName: "" }],
    [{ providerId: "proxy-a", profileName: "custom-proxy-a" }],
    [{ providerId: "proxy-a", profileName: "sf-ds-test" }],
  ])("rejects an invalid or conflicting managed Profile definition %j", (definition) => {
    expect(() => parseCodexRemoteOptions([], {
      customSwitchingProfiles: [definition],
    })).toThrow("受管模型 Provider Profile 定义无效或冲突");
  });

  it("rejects selecting two managed Provider profiles", () => {
    expect(() => parseCodexRemoteOptions([
      "--profile", "sf-ds-test",
      "--profile", "sf-ds-test",
    ])).toThrow("受管模型 Provider --profile 不能与其他 --profile 同时使用");
  });

  it.each([
    [["--profile", "personal", "--profile", "sf-ds-test"]],
    [["--profile=sf-ds-test", "-ppersonal"]],
  ])("rejects mixing managed and unmanaged profiles in %j", (args) => {
    expect(() => parseCodexRemoteOptions(args))
      .toThrow("受管模型 Provider --profile 不能与其他 --profile 同时使用");
  });
});
