import { describe, expect, it, vi } from "vitest";

import type { ConversationTarget } from "../src/conversation-core/index.js";
import { executeVisionCommand } from "../src/surfaces/vision-command.js";

const target: ConversationTarget = {
  surface: "telegram",
  accountId: "default",
  conversationId: "100",
};

describe("executeVisionCommand", () => {
  it("records, replaces, and cancels a one-shot prompt", async () => {
    const setVisionPrompt = vi.fn()
      .mockReturnValueOnce({ replaced: false })
      .mockReturnValueOnce({ replaced: true });
    const cancelVisionPrompt = vi.fn()
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false);
    const inputs = {
      beginVisionCollection: vi.fn(),
      cancelVisionPrompt,
      completeVisionCollection: vi.fn(),
      setVisionPrompt,
    };

    await expect(executeVisionCommand(inputs, target, "actor", "检查报错"))
      .resolves.toContain("已记录图片识别要求");
    await expect(executeVisionCommand(inputs, target, "actor", "重新检查"))
      .resolves.toContain("已替换图片识别要求");
    await expect(executeVisionCommand(inputs, target, "actor", "cancel"))
      .resolves.toBe("已取消待处理的图片识别要求。");
    await expect(executeVisionCommand(inputs, target, "actor", "CANCEL"))
      .resolves.toBe("当前没有待处理的图片识别要求。");
  });

  it("starts and completes an explicit multi-image collection", async () => {
    const inputs = {
      beginVisionCollection: vi.fn(() => ({ replacedPrompt: false })),
      cancelVisionPrompt: vi.fn(),
      completeVisionCollection: vi.fn(async () => ({
        imageCount: 2,
        submission: { threadId: "thread", turnId: "turn", steered: false },
      })),
      setVisionPrompt: vi.fn(),
    };

    await expect(executeVisionCommand(
      inputs,
      target,
      "actor",
      "begin 比较两张图片",
    )).resolves.toContain("已开始多图收集");
    expect(inputs.beginVisionCollection).toHaveBeenCalledWith(
      target,
      "actor",
      "比较两张图片",
    );
    await expect(executeVisionCommand(inputs, target, "actor", "done"))
      .resolves.toBe("已提交 2 张图片。");
  });

  it("rejects incomplete or malformed commands", async () => {
    const inputs = {
      beginVisionCollection: vi.fn(),
      cancelVisionPrompt: vi.fn(),
      completeVisionCollection: vi.fn(),
      setVisionPrompt: vi.fn(),
    };
    await expect(executeVisionCommand(inputs, target, "actor", " "))
      .rejects.toThrow("请使用 /vision");
    await expect(executeVisionCommand(inputs, target, "actor", "begin"))
      .rejects.toThrow("请使用 /vision");
    await expect(executeVisionCommand(inputs, target, "actor", "done now"))
      .rejects.toThrow("请使用 /vision");
  });
});
