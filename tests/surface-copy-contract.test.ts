import { describe, expect, it } from "vitest";

import type { ConversationStatus } from "../src/application/index.js";
import {
  conversationCommandHelpLines,
  formatConversationStatus,
} from "../src/surfaces/conversation-command-format.js";
import { formatConfigurationChange } from "../src/surfaces/telegram/format.js";
import {
  renderFeishuConfigurationChange,
  renderFeishuHelp,
} from "../src/surfaces/feishu/renderer.js";
import { renderWeixinHelp } from "../src/surfaces/weixin/command-renderer.js";

describe("shared surface copy contract", () => {
  it("keeps the shared command directory in Feishu and Weixin help", () => {
    for (const line of conversationCommandHelpLines) {
      expect(renderFeishuHelp()).toContain(line);
      expect(renderWeixinHelp()).toContain(line);
    }
  });

  it("formats the complete shared status including weekly limits", () => {
    const status: ConversationStatus = {
      workspaceId: "main",
      workspaceName: "Main",
      cwd: "/workspace/main",
      threadId: "thread-1",
      model: "gpt-main",
      effort: "medium",
      serviceTier: null,
      modelPending: false,
      effortPending: false,
      fastModePending: false,
      weeklyLimit: {
        usedPercent: 12,
        windowDurationMins: 10_080,
        resetsAt: null,
      },
      gitBranch: "feature/shared-copy",
    };

    expect(formatConversationStatus(status)).toContain(
      "周限：已使用 12% · 周期 10080 分钟",
    );
  });

  it("keeps Telegram and Feishu configuration lifecycle wording aligned", () => {
    const telegram = formatConfigurationChange({
      action: "restarting",
      changes: [{ code: "codex.default-model", scope: "global" }],
      addedWorkspaces: [],
    });
    const feishu = renderFeishuConfigurationChange({
      action: "restarting",
      changes: [{ code: "surface.feishu.credentials", scope: "feishu" }],
      addedWorkspaces: [],
    });

    for (const text of [
      "Gateway 配置需要重启",
      "当前 Gateway 将退出；若由系统服务托管，将自动重新启动。",
    ]) {
      expect(telegram).toContain(text);
      expect(feishu).toContain(text);
    }
    expect(feishu).toContain("变更：飞书应用凭据");
  });
});
