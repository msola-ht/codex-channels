import { describe, expect, it } from "vitest";

import { parseCodexRemoteOptions } from "../scripts/codex-remote-options.mjs";

describe("Codex Remote options", () => {
  it.each([
    [["--profile", "deepseek"], "deepseek"],
    [["--profile=opencode-go"], "opencode-go"],
    [["-popencode-go"], "opencode-go"],
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

  it("keeps the native custom Profile for Codex", () => {
    expect(parseCodexRemoteOptions(["--profile", "custom"])).toEqual({
      passthrough: ["--profile", "custom"],
      selectedProfile: undefined,
      workspaceId: undefined,
    });
  });

  it("selects a custom switching Profile from one supplied runtime snapshot", () => {
    expect(parseCodexRemoteOptions(
      ["--profile", "custom-proxy-a"],
      {
        customSwitchingProfiles: [{
          profileName: "custom-proxy-a",
          codexProfileName: "sf-custom-proxy-a",
        }],
      },
    )).toEqual({
      passthrough: [],
      selectedProfile: "custom-proxy-a",
      workspaceId: undefined,
    });
  });

  it.each([
    [["--profile", "sf-custom-proxy-a"]],
    [["--profile=sf-custom-proxy-a"]],
    [["-psf-custom-proxy-a"]],
  ])("rejects the internal custom Codex Profile from %j", (args) => {
    expect(() => parseCodexRemoteOptions(args, {
      customSwitchingProfiles: [{
        profileName: "custom-proxy-a",
        codexProfileName: "sf-custom-proxy-a",
      }],
    })).toThrow(
      "Codex Profile sf-custom-proxy-a 是内部名称；请使用 --profile custom-proxy-a",
    );
  });

  it.each([
    ["sf-deepseek", "deepseek"],
    ["sf-opencode-go", "opencode-go"],
  ])("rejects the managed internal Codex Profile %s", (codexProfileName, profileName) => {
    expect(() => parseCodexRemoteOptions(["--profile", codexProfileName], {
      customSwitchingProfiles: [],
    })).toThrow(
      `Codex Profile ${codexProfileName} 是内部名称；请使用 --profile ${profileName}`,
    );
  });

  it.each([
    "sf-custom",
    "sf-custom-missing",
  ])("rejects the reserved custom internal Codex Profile %s", (codexProfileName) => {
    expect(() => parseCodexRemoteOptions(["--profile", codexProfileName], {
      customSwitchingProfiles: [],
    })).toThrow(codexProfileName === "sf-custom"
      ? "Codex Profile sf-custom 是内部保留名称；固定模式请直接使用 codexc remote"
      : "Codex Profile sf-custom-missing 是内部保留名称；请先运行 codexc setup 配置对应 Provider，再使用 --profile custom-missing");
  });

  it.each([
    [{ profileName: "", codexProfileName: "sf-custom-proxy-a" }],
    [{ profileName: "custom-proxy-a", codexProfileName: "" }],
    [{ profileName: "custom-proxy-a", codexProfileName: "custom-proxy-a" }],
    [{ profileName: "deepseek", codexProfileName: "sf-custom-proxy-a" }],
    [{ profileName: "custom-proxy-a", codexProfileName: "sf-deepseek" }],
  ])("rejects an invalid or conflicting managed Profile definition %j", (definition) => {
    expect(() => parseCodexRemoteOptions([], {
      customSwitchingProfiles: [definition],
    })).toThrow("受管模型 Provider Profile 定义无效或冲突");
  });

  it("rejects selecting two managed Provider profiles", () => {
    expect(() => parseCodexRemoteOptions([
      "--profile", "deepseek",
      "--profile", "opencode-go",
    ])).toThrow("受管模型 Provider --profile 不能与其他 --profile 同时使用");
  });

  it.each([
    [["--profile", "personal", "--profile", "opencode-go"]],
    [["--profile=deepseek", "-ppersonal"]],
  ])("rejects mixing managed and unmanaged profiles in %j", (args) => {
    expect(() => parseCodexRemoteOptions(args))
      .toThrow("受管模型 Provider --profile 不能与其他 --profile 同时使用");
  });
});
