import { describe, expect, it } from "vitest";

import { UserFacingError } from "../src/conversation-core/index.js";
import { formatTelegramUserFacingError } from "../src/surfaces/telegram/user-error-renderer.js";

describe("Telegram user error renderer", () => {
  it("renders platform syntax from an error code instead of the internal fallback", () => {
    const error = new UserFacingError(
      "fast.usage",
      "opaque-internal-fallback",
    );

    expect(formatTelegramUserFacingError(error)).toBe(
      "用法：/fast [on|off|status]",
    );
    expect(formatTelegramUserFacingError(error)).not.toContain("opaque");
  });

  it("renders semantic command details with Telegram slash syntax", () => {
    const error = new UserFacingError(
      "session.selector.required",
      "selector required",
      { command: "unarchive" },
    );

    expect(formatTelegramUserFacingError(error)).toContain("/unarchive");
  });

  it.each([
    ["queue.usage", "用法：/queue <描述>"],
    ["queue.inactive", "当前没有运行中的任务，请直接发送普通消息"],
    ["queue.full", "下一 Turn 队列已满，最多 10 条"],
    ["queue.thread-changed", "排队消息所属会话已切换，队列已清空"],
  ] as const)("renders %s follow-up queue errors", (code, expected) => {
    expect(formatTelegramUserFacingError(
      new UserFacingError(code, "opaque-internal-fallback"),
    )).toBe(expected);
  });

  it.each([
    ["rules.usage", "用法：/rules <init|check>"],
    ["rules.exists", "当前 Workspace 已有项目规则；Telegram 不提供强制覆盖，请在终端中处理"],
    ["rules.missing", "当前 Workspace 尚未生成项目规则，请先使用 /rules init"],
    ["rules.unsafe-path", "项目规则路径包含符号链接，已拒绝写入"],
  ] as const)("renders %s project rule errors", (code, expected) => {
    expect(formatTelegramUserFacingError(
      new UserFacingError(code, "opaque-internal-fallback"),
    )).toBe(expected);
  });
});
