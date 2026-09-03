import { describe, expect, it } from "vitest";

import { resolveSettingsLoadState } from "../webui/src/lib/settings-state.js";

describe("WebUI 设置加载状态", () => {
  it("does not present fallback settings while the request is loading", () => {
    expect(resolveSettingsLoadState(null, true, null)).toBe("loading");
  });

  it("presents request failures instead of treating them as empty settings", () => {
    expect(resolveSettingsLoadState(null, false, "请求失败")).toBe("error");
  });

  it("distinguishes an empty response from a successful settings response", () => {
    expect(resolveSettingsLoadState(null, false, null)).toBe("empty");
    expect(resolveSettingsLoadState({ currency: "usd", exchangeRate: null }, false, null)).toBe("ready");
  });
});
