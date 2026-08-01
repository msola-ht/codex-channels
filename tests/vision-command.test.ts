import { describe, expect, it, vi } from "vitest";

import type { ConversationTarget } from "../src/conversation-core/index.js";
import { executeVisionCommand } from "../src/surfaces/vision-command.js";

const target: ConversationTarget = {
  surface: "telegram",
  accountId: "default",
  conversationId: "100",
};

describe("executeVisionCommand", () => {
  it("records, replaces, and cancels a one-shot prompt", () => {
    const setVisionPrompt = vi.fn()
      .mockReturnValueOnce({ replaced: false })
      .mockReturnValueOnce({ replaced: true });
    const cancelVisionPrompt = vi.fn()
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false);
    const inputs = { setVisionPrompt, cancelVisionPrompt };

    expect(executeVisionCommand(inputs, target, "actor", "检查报错"))
      .toContain("已记录图片识别要求");
    expect(executeVisionCommand(inputs, target, "actor", "重新检查"))
      .toContain("已替换图片识别要求");
    expect(executeVisionCommand(inputs, target, "actor", "cancel"))
      .toBe("已取消待处理的图片识别要求。");
    expect(executeVisionCommand(inputs, target, "actor", "CANCEL"))
      .toBe("当前没有待处理的图片识别要求。");
  });

  it("rejects an empty command", () => {
    expect(() => executeVisionCommand({
      setVisionPrompt: vi.fn(),
      cancelVisionPrompt: vi.fn(),
    }, target, "actor", " ")).toThrow("请使用 /vision");
  });
});
