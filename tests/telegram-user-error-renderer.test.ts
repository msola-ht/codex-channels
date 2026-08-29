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

  it("distinguishes a batch image limit from a single-image limit", () => {
    expect(formatTelegramUserFacingError(new UserFacingError(
      "image.too-large",
      "opaque",
      { scope: "batch" },
    ))).toBe("图片总大小超过 20 MiB 限制");
  });

  it.each([
    ["skill.usage", "用法：/skill <名称或序号> <任务>"],
    ["skill.not-found", "指定的 Skill 不存在、未启用或不属于当前 Workspace"],
  ] as const)("renders %s Skill errors", (code, expected) => {
    expect(formatTelegramUserFacingError(
      new UserFacingError(code, "opaque-internal-fallback"),
    )).toBe(expected);
  });

  it.each([
    ["queue.usage", "用法：/queue add <文本> | /queue list [页码] | /queue update <完整 ID 或当前列表序号> <文本> | /queue delete <完整 ID 或当前列表序号> | /queue reorder <完整 ID 或当前列表序号> <目标位置> | /queue start [完整 ID 或当前列表序号]"],
    ["queue.unavailable", "当前 App Server 不提供持久队列"],
    ["queue.empty", "App Server Queue 为空，请先使用 /queue add 新增条目"],
    ["queue.busy", "当前 Session 有活动或待触发 Turn，请稍后重试"],
    ["queue.pending-overrides", "Queue 与待生效的模型、思考、Fast 或 Plan 选择不能同时存在；请先让其中一方处理完成"],
    ["queue.full", "App Server Queue 已满，最多 100 条"],
    ["queue.snapshot.required", "数字选择器只对最近五分钟的本会话 Queue 列表有效，请先执行 /queue list"],
  ] as const)("renders %s native queue errors", (code, expected) => {
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
