import { describe, expect, it } from "vitest";

import { parseBackgroundUpdateArgs } from "../scripts/background-update-options.mjs";

const taskId = "b87a9f86-cd80-4e63-a578-c8c7d199742d";

describe("background update options", () => {
  it("preserves the interactive entry and accepts only explicit local-source submission", () => {
    expect(parseBackgroundUpdateArgs([])).toEqual({ kind: "interactive" });
    for (const args of [["--background", "--source", "./source tree"], ["--source", "./source tree", "--background"]]) {
      expect(parseBackgroundUpdateArgs(args)).toEqual({ kind: "submit", sourceDirectory: "./source tree" });
    }
  });

  it("accepts latest or explicit status without filesystem access", () => {
    expect(parseBackgroundUpdateArgs(["status"])).toEqual({ kind: "status", taskId: undefined, json: false });
    expect(parseBackgroundUpdateArgs(["status", "--json"])).toEqual({ kind: "status", taskId: undefined, json: true });
    expect(parseBackgroundUpdateArgs(["status", taskId])).toEqual({ kind: "status", taskId, json: false });
    expect(parseBackgroundUpdateArgs(["status", taskId.toUpperCase(), "--json"])).toEqual({ kind: "status", taskId, json: true });
  });

  it("accepts help only for exact public command paths", () => {
    for (const flag of ["-h", "--help"]) {
      expect(parseBackgroundUpdateArgs([flag])).toEqual({ kind: "help", topic: "update" });
      expect(parseBackgroundUpdateArgs(["status", flag])).toEqual({ kind: "help", topic: "status" });
      for (const args of [[flag, "status"], ["--background", flag], ["status", taskId, flag], ["status", "--json", flag], ["status", flag, "extra"], ["nonsense", flag], [flag, flag]]) {
        expect(() => parseBackgroundUpdateArgs(args)).toThrow("用法：codexc update");
      }
    }
  });

  it.each([
    ["--background"], ["--source", "local"], ["--source"],
    ["--background", "--source"], ["--background", "--source", "--background"],
    ["--background", "--source", ""], ["--background", "--source", "  "],
    ["--background", "--background", "--source", "local"],
    ["--background", "--source", "local", "--source", "other"],
    ["--background", "--source", "local", "extra"],
    ["--background", "--main"], ["--unknown"], ["status", "../outside"],
    ["status", "invalid-id"], ["status", taskId, taskId],
    ["status", "--json", "--json"], ["status", "--json", taskId],
    ["status", taskId, "--unknown"], ["status", "--background"],
  ])("rejects unsupported, duplicated and incomplete arguments %j", (...args) => {
    expect(() => parseBackgroundUpdateArgs(args)).toThrow();
  });
});
