import { describe, expect, it, vi } from "vitest";

// @ts-expect-error JavaScript CLI helper intentionally has no declaration file.
import { runSetup } from "../scripts/setup.mjs";

describe("Codex Connect setup", () => {
  it("selects Telegram under the communication channels category", async () => {
    const input = {};
    const output = {};
    const telegramSetup = vi.fn(async () => "telegram-configured");
    const intro = vi.fn();
    const select = vi.fn()
      .mockResolvedValueOnce("channels")
      .mockResolvedValueOnce("telegram");

    const result = await runSetup({
      input,
      output,
      prompts: {
        intro,
        select,
        isCancel: () => false,
        cancel: vi.fn(),
      },
      telegramSetup,
    });

    expect(result).toBe("telegram-configured");
    expect(intro).toHaveBeenCalledWith("Codex Connect Setup");
    expect(select).toHaveBeenNthCalledWith(1, {
      message: "选择设置类别",
      showInstructions: false,
      options: [{
        value: "channels",
        label: "通讯渠道",
        hint: "配置外部消息入口",
      }],
    });
    expect(select).toHaveBeenNthCalledWith(2, {
      message: "选择通讯渠道",
      showInstructions: false,
      options: [{
        value: "telegram",
        label: "Telegram",
        hint: "Bot、用户授权与消息格式",
      }],
    });
    expect(telegramSetup).toHaveBeenCalledWith({ input, output });
  });

  it("cancels without starting a module setup", async () => {
    const telegramSetup = vi.fn();
    const cancel = vi.fn();

    const result = await runSetup({
      prompts: {
        intro: vi.fn(),
        select: async () => Symbol("cancel"),
        isCancel: () => true,
        cancel,
      },
      telegramSetup,
    });

    expect(result).toBeUndefined();
    expect(cancel).toHaveBeenCalledWith("Setup 已取消");
    expect(telegramSetup).not.toHaveBeenCalled();
  });

  it("cancels from the channel menu without starting Telegram setup", async () => {
    const telegramSetup = vi.fn();
    const cancel = vi.fn();
    const select = vi.fn()
      .mockResolvedValueOnce("channels")
      .mockResolvedValueOnce(Symbol("cancel"));

    const result = await runSetup({
      prompts: {
        intro: vi.fn(),
        select,
        isCancel: (value: unknown) => typeof value === "symbol",
        cancel,
      },
      telegramSetup,
    });

    expect(result).toBeUndefined();
    expect(cancel).toHaveBeenCalledWith("Setup 已取消");
    expect(telegramSetup).not.toHaveBeenCalled();
  });
});
