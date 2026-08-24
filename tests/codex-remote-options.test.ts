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
      ["--profile", "sf-custom-proxy-a"],
      { customSwitchingProfiles: ["sf-custom-proxy-a"] },
    )).toEqual({
      passthrough: [],
      selectedProfile: "sf-custom-proxy-a",
      workspaceId: undefined,
    });
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
