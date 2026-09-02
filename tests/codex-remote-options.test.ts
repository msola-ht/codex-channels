import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { writeOpencodeGoAccounts } from "../runtime/opencode-go-accounts.mjs";
import { parseCodexRemoteOptions as parseCodexRemoteOptionsRaw } from "../scripts/codex-remote-options.mjs";

const isolatedEnvironment = {
  CODEX_HOME: join(tmpdir(), "codexc-remote-options-empty-codex"),
  CODEX_CONNECT_HOME: join(tmpdir(), "codexc-remote-options-empty-connect"),
};

function parseCodexRemoteOptions(
  args: Parameters<typeof parseCodexRemoteOptionsRaw>[0],
  options: NonNullable<Parameters<typeof parseCodexRemoteOptionsRaw>[1]> = {},
) {
  return parseCodexRemoteOptionsRaw(args, { environment: isolatedEnvironment, ...options });
}

describe("Codex Remote options", () => {
  it.each([
    [["--profile", "sf-deepseek"], "sf-deepseek"],
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
    ["deepseek", "sf-deepseek"],
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

  it.each([
    ["sf-ocg-missing", "OpenCode Go Profile sf-ocg-missing 尚未配置"],
    ["sf-opencode-go-missing", "OpenCode Go Profile sf-opencode-go-missing 已废弃"],
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
    [{ providerId: "proxy-a", profileName: "sf-deepseek" }],
  ])("rejects an invalid or conflicting managed Profile definition %j", (definition) => {
    expect(() => parseCodexRemoteOptions([], {
      customSwitchingProfiles: [definition],
    })).toThrow("受管模型 Provider Profile 定义无效或冲突");
  });

  it("rejects selecting two managed Provider profiles", () => {
    expect(() => parseCodexRemoteOptions([
      "--profile", "sf-deepseek",
      "--profile", "sf-deepseek",
    ])).toThrow("受管模型 Provider --profile 不能与其他 --profile 同时使用");
  });

  it.each([
    [["--profile", "personal", "--profile", "sf-deepseek"]],
    [["--profile=sf-deepseek", "-ppersonal"]],
  ])("rejects mixing managed and unmanaged profiles in %j", (args) => {
    expect(() => parseCodexRemoteOptions(args))
      .toThrow("受管模型 Provider --profile 不能与其他 --profile 同时使用");
  });
});
