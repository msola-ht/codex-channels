import { describe, expect, it } from "vitest";

import { reconcileSettingsDraft, resolveSettingsLoadState } from "../webui/src/lib/settings-state.js";

describe("WebUI 设置加载状态", () => {
  it("does not present fallback settings while the request is loading", () => {
    expect(resolveSettingsLoadState(null, true, null)).toBe("loading");
  });

  it("presents request failures instead of treating them as empty settings", () => {
    expect(resolveSettingsLoadState(null, false, "请求失败")).toBe("error");
  });

  it("distinguishes an empty response from a successful settings response", () => {
    expect(resolveSettingsLoadState(null, false, null)).toBe("empty");
    expect(resolveSettingsLoadState({ revision: "r1" }, false, null)).toBe("ready");
  });

  it("keeps the current settings visible during a background refresh", () => {
    expect(resolveSettingsLoadState({ revision: "r1" }, true, null)).toBe("ready");
    expect(resolveSettingsLoadState({ revision: "r1" }, false, "refresh failed")).toBe("ready");
  });
});

describe("WebUI 设置草稿", () => {
  it("preserves edited fields while untouched fields follow a refreshed snapshot", () => {
    const snapshot = { name: "remote", port: "9000" };
    const edits = reconcileSettingsDraft(snapshot, { name: "draft" });
    expect({ ...snapshot, ...edits }).toEqual({ name: "draft", port: "9000" });
  });
  it("releases fields acknowledged by the server without clearing unrelated edits", () => {
    expect(reconcileSettingsDraft({ name: "saved", port: "9000" }, { name: "saved", port: "9001" }))
      .toEqual({ port: "9001" });
  });
});
