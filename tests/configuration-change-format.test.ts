import { describe, expect, it } from "vitest";

import { configChange } from "../src/config/index.js";
import { formatSurfaceConfigurationChange } from "../src/surfaces/configuration-change-format.js";
import type { SurfaceConfigurationChange } from "../src/surfaces/types.js";

describe("formatSurfaceConfigurationChange", () => {
  it("渲染第三方模型设置变更的四个动作", () => {
    const base: SurfaceConfigurationChange = {
      action: "provider-settings-scheduled",
      changes: [configChange("provider.settings")],
      addedWorkspaces: [],
      providers: ["opencode-go", "deepseek"],
    };

    const scheduled = formatSurfaceConfigurationChange(
      { ...base, action: "provider-settings-scheduled" },
      "telegram",
    );
    expect(scheduled).toContain("第三方模型设置已更新");
    expect(scheduled).toContain("Provider：opencode-go、deepseek");
    expect(scheduled).toContain("等待当前任务完成后自动重启");

    const restarting = formatSurfaceConfigurationChange(
      { ...base, action: "provider-settings-restarting" },
      "telegram",
    );
    expect(restarting).toContain("正在重启 App Server");

    const applied = formatSurfaceConfigurationChange(
      { ...base, action: "provider-settings-applied" },
      "telegram",
    );
    expect(applied).toContain("第三方模型设置已生效");
    expect(applied).toContain("App Server 已重启");

    const failed = formatSurfaceConfigurationChange(
      { ...base, action: "provider-settings-failed" },
      "telegram",
    );
    expect(failed).toContain("App Server 重启失败");
    expect(failed).toContain("自动重试");
  });
});
