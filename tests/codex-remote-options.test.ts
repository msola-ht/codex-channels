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
      "--profile", "custom",
      "--",
      "--profile", "opencode-go",
    ])).toEqual({
      passthrough: ["--profile", "custom", "--", "--profile", "opencode-go"],
      selectedProfile: undefined,
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
    [["--profile", "custom", "--profile", "opencode-go"]],
    [["--profile=deepseek", "-pcustom"]],
  ])("rejects mixing managed and unmanaged profiles in %j", (args) => {
    expect(() => parseCodexRemoteOptions(args))
      .toThrow("受管模型 Provider --profile 不能与其他 --profile 同时使用");
  });
});
