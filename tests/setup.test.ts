import { describe, expect, it, vi } from "vitest";

// @ts-expect-error JavaScript CLI helper intentionally has no declaration file.
import { runSetup } from "../scripts/setup.mjs";

describe("Codex Connect setup", () => {
  it("selects Telegram under the communication channels category", async () => {
    const input = {};
    const output = {};
    const telegramSetup = vi.fn(async () => "telegram-configured");
    const feishuSetup = vi.fn();
    const weixinSetup = vi.fn();
    const deepseekSetup = vi.fn();
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
      feishuSetup,
      weixinSetup,
      deepseekSetup,
    });

    expect(result).toBe("telegram-configured");
    expect(intro).toHaveBeenCalledWith("Codex Connect Setup");
    expect(select).toHaveBeenNthCalledWith(1, {
      message: "选择设置类别",
      showInstructions: false,
      options: [{
        value: "models",
        label: "模型与提供商",
        hint: "设置 Codex 官方默认值、第三方模型、API 与图片识别",
      }, {
        value: "channels",
        label: "通讯渠道",
        hint: "配置外部消息入口",
      }, {
        value: "skills",
        label: "技能",
        hint: "安装或卸载项目技能到用户目录",
      }, {
        value: "cancel",
        label: "取消",
        hint: "退出 Setup",
      }],
    });
    expect(select).toHaveBeenNthCalledWith(2, {
      message: "选择通讯渠道",
      showInstructions: false,
      options: [{
        value: "telegram",
        label: "Telegram",
        hint: "Bot、用户授权与消息格式",
      }, {
        value: "feishu",
        label: "飞书",
        hint: "企业自建应用与用户授权",
      }, {
        value: "weixin",
        label: "微信",
        hint: "扫码连接与用户授权",
      }, {
        value: "back",
        label: "返回",
        hint: "返回设置类别",
      }],
    });
    expect(telegramSetup).toHaveBeenCalledWith({ input, output });
    expect(feishuSetup).not.toHaveBeenCalled();
  });

  it("selects Feishu under the communication channels category", async () => {
    const input = {};
    const output = {};
    const telegramSetup = vi.fn();
    const feishuSetup = vi.fn(async () => "feishu-configured");
    const weixinSetup = vi.fn();

    const result = await runSetup({
      input,
      output,
      prompts: {
        intro: vi.fn(),
        select: vi.fn()
          .mockResolvedValueOnce("channels")
          .mockResolvedValueOnce("feishu"),
        isCancel: () => false,
        cancel: vi.fn(),
      },
      telegramSetup,
      feishuSetup,
      weixinSetup,
    });

    expect(result).toBe("feishu-configured");
    expect(feishuSetup).toHaveBeenCalledWith({ input, output });
    expect(telegramSetup).not.toHaveBeenCalled();
  });

  it("selects Weixin under the communication channels category", async () => {
    const weixinSetup = vi.fn(async () => "weixin-configured");
    const result = await runSetup({
      input: {},
      output: {},
      prompts: {
        intro: vi.fn(),
        select: vi.fn()
          .mockResolvedValueOnce("channels")
          .mockResolvedValueOnce("weixin"),
        isCancel: () => false,
        cancel: vi.fn(),
      },
      telegramSetup: vi.fn(),
      feishuSetup: vi.fn(),
      weixinSetup,
    });

    expect(result).toBe("weixin-configured");
    expect(weixinSetup).toHaveBeenCalledOnce();
  });

  it("selects the model provider setup category", async () => {
    const input = {};
    const output = {};
    const prompts = {
      intro: vi.fn(),
      select: vi.fn()
        .mockResolvedValueOnce("models")
        .mockResolvedValueOnce("deepseek"),
      isCancel: () => false,
      cancel: vi.fn(),
    };
    const deepseekSetup = vi.fn(async () => "deepseek-configured");

    const result = await runSetup({
      input,
      output,
      prompts,
      telegramSetup: vi.fn(),
      feishuSetup: vi.fn(),
      weixinSetup: vi.fn(),
      deepseekSetup,
    });

    expect(result).toBe("deepseek-configured");
    expect(deepseekSetup).toHaveBeenCalledWith({ input, output, prompts, allowBack: true });
  });

  it("selects official Codex global model settings under models and providers", async () => {
    const input = {};
    const output = {};
    const prompts = {
      intro: vi.fn(),
      select: vi.fn()
        .mockResolvedValueOnce("models")
        .mockResolvedValueOnce("codex"),
      isCancel: () => false,
      cancel: vi.fn(),
    };
    const codexDefaultsSetup = vi.fn(async () => "codex-defaults-configured");

    await expect(runSetup({
      input,
      output,
      prompts,
      codexDefaultsSetup,
    })).resolves.toBe("codex-defaults-configured");

    expect(codexDefaultsSetup).toHaveBeenCalledWith({
      input,
      output,
      prompts,
      allowBack: true,
    });
    const modelOptions = prompts.select.mock.calls[1]?.[0]?.options ?? [];
    expect(modelOptions).toContainEqual({
      value: "codex",
      label: "Codex 官方",
      hint: "设置全局默认模型与思考等级",
    });
  });

  it("selects managed third-party default model settings", async () => {
    const input = {};
    const output = {};
    const prompts = {
      intro: vi.fn(),
      select: vi.fn()
        .mockResolvedValueOnce("models")
        .mockResolvedValueOnce("provider_default"),
      isCancel: () => false,
      cancel: vi.fn(),
    };
    const modelProviderDefaultSetup = vi.fn(async () => "provider-default-configured");

    await expect(runSetup({
      input,
      output,
      prompts,
      modelProviderDefaultSetup,
    })).resolves.toBe("provider-default-configured");

    expect(modelProviderDefaultSetup).toHaveBeenCalledWith({
      input,
      output,
      prompts,
      allowBack: true,
    });
    expect(prompts.select.mock.calls[1]?.[0]?.options).toContainEqual({
      value: "provider_default",
      label: "第三方默认模型",
      hint: "按 Provider 设置新会话使用的默认模型",
    });
  });

  it("selects image recognition under the models and providers category", async () => {
    const visionSetup = vi.fn(async () => "vision-configured");
    const prompts = {
      intro: vi.fn(),
      select: vi.fn()
        .mockResolvedValueOnce("models")
        .mockResolvedValueOnce("vision"),
      isCancel: () => false,
      cancel: vi.fn(),
    };

    await expect(runSetup({
      input: {},
      output: {},
      prompts,
      deepseekSetup: vi.fn(),
      visionSetup,
    })).resolves.toBe("vision-configured");

    expect(visionSetup).toHaveBeenCalledWith({ input: {}, output: {}, prompts });
  });

  it("selects third-party API management without entering DeepSeek setup", async () => {
    const apiProviderSetup = vi.fn(async () => "api-provider-configured");
    const deepseekSetup = vi.fn();
    const prompts = {
      intro: vi.fn(),
      select: vi.fn()
        .mockResolvedValueOnce("models")
        .mockResolvedValueOnce("api_provider"),
      isCancel: () => false,
      cancel: vi.fn(),
    };

    await expect(runSetup({
      input: {},
      output: {},
      prompts,
      deepseekSetup,
      apiProviderSetup,
    })).resolves.toBe("api-provider-configured");

    expect(apiProviderSetup).toHaveBeenCalledWith({ input: {}, output: {}, prompts });
    expect(deepseekSetup).not.toHaveBeenCalled();
  });

  it("returns from the channel menu and can cancel at the category menu", async () => {
    const cancel = vi.fn();
    const select = vi.fn()
      .mockResolvedValueOnce("channels")
      .mockResolvedValueOnce("back")
      .mockResolvedValueOnce("cancel");
    const telegramSetup = vi.fn();

    const result = await runSetup({
      prompts: {
        intro: vi.fn(),
        select,
        isCancel: () => false,
        cancel,
      },
      telegramSetup,
      feishuSetup: vi.fn(),
      weixinSetup: vi.fn(),
      deepseekSetup: vi.fn(),
    });

    expect(result).toBeUndefined();
    expect(select).toHaveBeenCalledTimes(3);
    expect(cancel).toHaveBeenCalledWith("Setup 已取消");
    expect(telegramSetup).not.toHaveBeenCalled();
  });

  it("returns from the model menu to the category menu", async () => {
    const cancel = vi.fn();
    const deepseekSetup = vi.fn(async () => ({ action: "back" }));
    const select = vi.fn()
      .mockResolvedValueOnce("models")
      .mockResolvedValueOnce("deepseek")
      .mockResolvedValueOnce("cancel");

    const result = await runSetup({
      input: {},
      output: {},
      prompts: {
        intro: vi.fn(),
        select,
        isCancel: () => false,
        cancel,
      },
      telegramSetup: vi.fn(),
      feishuSetup: vi.fn(),
      weixinSetup: vi.fn(),
      deepseekSetup,
    });

    expect(result).toBeUndefined();
    expect(deepseekSetup).toHaveBeenCalledWith(expect.objectContaining({ allowBack: true }));
    expect(select).toHaveBeenCalledTimes(3);
    expect(cancel).toHaveBeenCalledWith("Setup 已取消");
  });

  it("cancels without starting a module setup", async () => {
    const telegramSetup = vi.fn();
    const feishuSetup = vi.fn();
    const weixinSetup = vi.fn();
    const cancel = vi.fn();

    const result = await runSetup({
      prompts: {
        intro: vi.fn(),
        select: async () => Symbol("cancel"),
        isCancel: () => true,
        cancel,
      },
      telegramSetup,
      feishuSetup,
      weixinSetup,
    });

    expect(result).toBeUndefined();
    expect(cancel).toHaveBeenCalledWith("Setup 已取消");
    expect(telegramSetup).not.toHaveBeenCalled();
    expect(feishuSetup).not.toHaveBeenCalled();
  });

  it("returns from the channel menu when the prompt is cancelled", async () => {
    const telegramSetup = vi.fn();
    const feishuSetup = vi.fn();
    const weixinSetup = vi.fn();
    const cancel = vi.fn();
    const select = vi.fn()
      .mockResolvedValueOnce("channels")
      .mockResolvedValueOnce(Symbol("cancel"))
      .mockResolvedValueOnce("cancel");

    const result = await runSetup({
      prompts: {
        intro: vi.fn(),
        select,
        isCancel: (value: unknown) => typeof value === "symbol",
        cancel,
      },
      telegramSetup,
      feishuSetup,
      weixinSetup,
    });

    expect(result).toBeUndefined();
    expect(cancel).toHaveBeenCalledWith("Setup 已取消");
    expect(select).toHaveBeenCalledTimes(3);
    expect(telegramSetup).not.toHaveBeenCalled();
    expect(feishuSetup).not.toHaveBeenCalled();
  });
});
