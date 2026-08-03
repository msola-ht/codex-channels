import { describe, expect, it, vi } from "vitest";

import type { ConversationTarget } from "../src/conversation-core/index.js";
import {
  executeVisionCommand,
  formatVisionImagesCollected,
} from "../src/surfaces/vision-command.js";

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
      retryVision: vi.fn(),
      setVisionPrompt,
    };

    await expect(executeVisionCommand(inputs, target, "actor", "检查报错"))
      .resolves.toContain("图片识别要求已记录");
    await expect(executeVisionCommand(inputs, target, "actor", "重新检查"))
      .resolves.toContain("图片识别要求已更新");
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
      retryVision: vi.fn(),
      setVisionPrompt: vi.fn(),
    };

    await expect(executeVisionCommand(
      inputs,
      target,
      "actor",
      "begin 比较两张图片",
    )).resolves.toContain("图片收集已开始");
    expect(inputs.beginVisionCollection).toHaveBeenCalledWith(
      target,
      "actor",
      "比较两张图片",
    );
    await expect(executeVisionCommand(inputs, target, "actor", "done"))
      .resolves.toContain("- 状态：已进入处理队列");
  });

  it("starts a sized collection that will submit automatically", async () => {
    const inputs = {
      beginVisionCollection: vi.fn(() => ({ replacedPrompt: false })),
      cancelVisionPrompt: vi.fn(),
      completeVisionCollection: vi.fn(),
      retryVision: vi.fn(),
      setVisionPrompt: vi.fn(),
    };

    await expect(executeVisionCommand(
      inputs,
      target,
      "actor",
      "3 比较这些图片",
    )).resolves.toContain("- 目标：3 张图片");
    expect(inputs.beginVisionCollection).toHaveBeenCalledWith(
      target,
      "actor",
      "比较这些图片",
      3,
    );
  });

  it("retries the latest failed vision submission", async () => {
    const retryVision = vi.fn(async () => ({
      imageCount: 2,
      submission: { threadId: "thread", turnId: "turn", steered: false },
    }));
    const inputs = {
      beginVisionCollection: vi.fn(),
      cancelVisionPrompt: vi.fn(),
      completeVisionCollection: vi.fn(),
      retryVision,
      setVisionPrompt: vi.fn(),
    };

    await expect(executeVisionCommand(inputs, target, "actor", "retry"))
      .resolves.toContain("图片识别已重新提交");
    expect(retryVision).toHaveBeenCalledWith(target, "actor");
    await expect(executeVisionCommand(inputs, target, "actor", "retry now"))
      .rejects.toThrow("请使用 /vision");
  });

  it("rejects incomplete or malformed commands", async () => {
    const inputs = {
      beginVisionCollection: vi.fn(),
      cancelVisionPrompt: vi.fn(),
      completeVisionCollection: vi.fn(),
      retryVision: vi.fn(),
      setVisionPrompt: vi.fn(),
    };
    await expect(executeVisionCommand(inputs, target, "actor", " "))
      .rejects.toThrow("请使用 /vision");
    await expect(executeVisionCommand(inputs, target, "actor", "begin"))
      .rejects.toThrow("请使用 /vision");
    await expect(executeVisionCommand(inputs, target, "actor", "done now"))
      .rejects.toThrow("请使用 /vision");
    await expect(executeVisionCommand(inputs, target, "actor", "2"))
      .rejects.toThrow("请使用 /vision");
  });

  it("distinguishes automatic and manual collection progress", () => {
    expect(formatVisionImagesCollected(1, 3, true))
      .toContain("收齐后自动提交");
    expect(formatVisionImagesCollected(1, 4))
      .toContain("提交：/vision done");
  });
});
