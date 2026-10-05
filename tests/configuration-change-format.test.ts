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
    expect(scheduled).toContain("等待对应 Provider 的任务结束并释放原生客户端租约后自动应用");

    const restarting = formatSurfaceConfigurationChange(
      { ...base, action: "provider-settings-restarting" },
      "telegram",
    );
    expect(restarting).toContain("正在检查并应用对应 Provider 的设置");

    const applied = formatSurfaceConfigurationChange(
      { ...base, action: "provider-settings-applied" },
      "telegram",
    );
    expect(applied).toContain("第三方模型设置已生效");
    expect(applied).toContain("设置应用与 Gateway 模型目录刷新已确认");

    const failed = formatSurfaceConfigurationChange(
      { ...base, action: "provider-settings-failed" },
      "telegram",
    );
    expect(failed).toContain("设置应用失败");
    expect(failed).toContain("在重试预算内自动重试，耗尽后等待设置变化或 Gateway 重建");
  });
});
