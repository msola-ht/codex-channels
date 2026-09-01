import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

import { describe, expect, it, vi } from "vitest";

// @ts-expect-error JavaScript CLI helper intentionally has no declaration file.
import { runSetup } from "../scripts/setup.mjs";
import {
  loadSetupConfigurationSummary,
  writeSetupConfigurationSummary,
} from "../scripts/setup-summary.mjs";

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
        value: "summary",
        label: "配置总览",
        hint: "脱敏显示 Provider、模型、共享子代理、通讯渠道与用户技能状态",
      }, {
        value: "codex_user",
        label: "Codex 新会话默认值",
        hint: "OpenAI 官方默认模型、思考等级、Fast、权限与用户偏好",
      }, {
        value: "models",
        label: "模型与提供商",
        hint: "管理 OpenAI、第三方 Provider 与模型默认值",
      }, {
        value: "channels",
        label: "通讯渠道",
        hint: "配置外部消息入口",
      }, {
        value: "skills",
        label: "项目技能",
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

  it("shows the redacted Setup summary and keeps the main menu open", async () => {
    const output = {};
    const setupSummary = vi.fn();
    const select = vi.fn()
      .mockResolvedValueOnce("summary")
      .mockResolvedValueOnce("cancel");

    await expect(runSetup({
      output,
      prompts: {
        intro: vi.fn(),
        select,
        isCancel: () => false,
        cancel: vi.fn(),
      },
      setupSummary,
    })).resolves.toBeUndefined();

    expect(setupSummary).toHaveBeenCalledWith({ output });
    expect(select).toHaveBeenCalledTimes(2);
  });

  it("emits enriched JSON-mode results before returning to the menu", async () => {
    const events: unknown[] = [];
    const select = vi.fn()
      .mockResolvedValueOnce("channels")
      .mockResolvedValueOnce("telegram")
      .mockResolvedValueOnce("cancel");

    await expect(runSetup({
      output: {},
      prompts: {
        intro: vi.fn(),
        select,
        isCancel: () => false,
        cancel: vi.fn(),
      },
      telegramSetup: vi.fn(async () => ({
        action: "configured",
        message: "api_key=secret",
        generatedTokens: { deviceToken: "secret" },
      })),
      feishuSetup: vi.fn(),
      weixinSetup: vi.fn(),
      stayOnMenu: true,
      onResult: (event: unknown) => events.push(event),
    })).resolves.toBeUndefined();

    expect(events).toEqual([
      {
        event: "result",
        category: "channels",
        result: {
          action: "configured",
          message: "api_key=[REDACTED]",
          generatedTokens: { generated: true },
          activation: "restart-gateway",
          activationResult: {
            status: "restart",
            target: "gateway",
            commands: ["codexc service restart gateway"],
          },
        },
      },
      { event: "cancelled" },
    ]);
  });

  it("keeps JSON-mode stdout parseable when the interactive process is cancelled", () => {
    const child = spawnSync(
      process.execPath,
      [resolve("scripts/setup.mjs"), "--json"],
      {
        cwd: process.cwd(),
        env: { ...process.env, NO_COLOR: "1" },
        input: "\u001b",
        encoding: "utf8",
        timeout: 10_000,
      },
    );

    expect(child.error).toBeUndefined();
    expect(child.status).toBe(0);
    expect(child.stdout.trim().split("\n").map((line) => JSON.parse(line))).toEqual([
      { event: "cancelled" },
    ]);
    expect(child.stderr).toContain("选择设置类别");
    expect(child.stdout).not.toContain("选择设置类别");
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
        .mockResolvedValueOnce("third_party")
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

  it("adds a stable activation result when a legacy provider setup omits it", async () => {
    const prompts = {
      intro: vi.fn(),
      select: vi.fn()
        .mockResolvedValueOnce("models")
        .mockResolvedValueOnce("official")
        .mockResolvedValueOnce("official_login"),
      isCancel: () => false,
      cancel: vi.fn(),
    };
    const result = await runSetup({
      input: {},
      output: {},
      prompts,
      officialLoginSetup: vi.fn(async () => ({ mode: "official" })),
    });

    expect(result).toMatchObject({
      mode: "official",
      activation: "restart-all",
      activationResult: {
        status: "restart",
        target: "all",
        commands: ["codexc service restart all"],
      },
    });
  });

  it("selects unified Codex user settings from the main category", async () => {
    const environment = { CODEX_HOME: "/tmp/codex-home" };
    const output = {};
    const prompts = {
      intro: vi.fn(),
      select: vi.fn()
        .mockResolvedValueOnce("codex_user"),
      isCancel: () => false,
      cancel: vi.fn(),
    };
    const codexDefaultsSetup = vi.fn(async () => "codex-defaults-configured");
    const codexUserSettingsSetup = vi.fn(async () => "codex-user-configured");

    await expect(runSetup({
      environment,
      output,
      prompts,
      codexDefaultsSetup,
      codexUserSettingsSetup,
    })).resolves.toBe("codex-user-configured");

    expect(codexUserSettingsSetup).toHaveBeenCalledWith({
      environment,
      output,
      prompts,
      defaultsSetup: codexDefaultsSetup,
    });
    expect(codexDefaultsSetup).not.toHaveBeenCalled();
  });

  it("selects the custom primary Provider setup under models and providers", async () => {
    const input = {};
    const output = {};
    const prompts = {
      intro: vi.fn(),
      select: vi.fn()
        .mockResolvedValueOnce("models")
        .mockResolvedValueOnce("third_party")
        .mockResolvedValueOnce("custom_primary"),
      isCancel: () => false,
      cancel: vi.fn(),
    };
    const customPrimarySetup = vi.fn(async () => "custom-primary-configured");

    const result = await runSetup({
      input,
      output,
      prompts,
      customPrimarySetup,
    });

    expect(result).toBe("custom-primary-configured");
    expect(customPrimarySetup).toHaveBeenCalledWith({
      input,
      output,
      prompts,
      allowBack: true,
    });
    expect(prompts.select.mock.calls[2]?.[0]?.options).toContainEqual({
      value: "custom_primary",
      label: "自定义 Responses Provider",
      hint: "管理固定或切换模式的 OpenAI Responses 兼容 Provider",
    });
  });

  it("selects shared third-party agent setup under models and providers", async () => {
    const input = {};
    const output = {};
    const prompts = {
      intro: vi.fn(),
      select: vi.fn()
        .mockResolvedValueOnce("models")
        .mockResolvedValueOnce("third_party")
        .mockResolvedValueOnce("agents"),
      isCancel: () => false,
      cancel: vi.fn(),
    };
    const agentsSetup = vi.fn(async () => "agents-configured");

    await expect(runSetup({
      input,
      output,
      prompts,
      agentsSetup,
    })).resolves.toBe("agents-configured");

    expect(agentsSetup).toHaveBeenCalledWith({
      input,
      output,
      prompts,
      allowBack: true,
    });
    expect(prompts.select.mock.calls[2]?.[0]?.options).toContainEqual({
      value: "agents",
      label: "共享第三方子代理",
      hint: "选择已配置 Provider 与模型，或停用 agents.external",
    });
  });

  it("selects the official login setup under models and providers", async () => {
    const input = {};
    const output = {};
    const prompts = {
      intro: vi.fn(),
      select: vi.fn()
        .mockResolvedValueOnce("models")
        .mockResolvedValueOnce("official")
        .mockResolvedValueOnce("official_login"),
      isCancel: () => false,
      cancel: vi.fn(),
    };
    const officialLoginSetup = vi.fn(async () => "official-login-configured");

    const result = await runSetup({
      input,
      output,
      prompts,
      officialLoginSetup,
    });

    expect(result).toBe("official-login-configured");
    expect(officialLoginSetup).toHaveBeenCalledWith({
      input,
      output,
      prompts,
    });
    expect(prompts.select.mock.calls[1]?.[0]?.options).toContainEqual({
      value: "official",
      label: "OpenAI 官方",
      hint: "OpenAI 官方登录与固定主 Provider 恢复",
    });
    expect(prompts.select.mock.calls[2]?.[0]?.options).not.toContainEqual(
      expect.objectContaining({ value: "codex" }),
    );
  });

  it("selects managed third-party default model settings", async () => {
    const input = {};
    const output = {};
    const prompts = {
      intro: vi.fn(),
      select: vi.fn()
        .mockResolvedValueOnce("models")
        .mockResolvedValueOnce("third_party")
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
    expect(prompts.select.mock.calls[2]?.[0]?.options).toContainEqual({
      value: "provider_default",
      label: "受管 Provider 模型设置",
      hint: "设置 DeepSeek 与 OpenCode Go 的模型、思考等级和自动压缩",
    });
  });

  it("selects third-party API management without entering DeepSeek setup", async () => {
    const apiProviderSetup = vi.fn(async () => "api-provider-configured");
    const deepseekSetup = vi.fn();
    const prompts = {
      intro: vi.fn(),
      select: vi.fn()
        .mockResolvedValueOnce("models")
        .mockResolvedValueOnce("third_party")
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
    expect(prompts.select.mock.calls[2]?.[0]?.options).toContainEqual({
      value: "api_provider",
      label: "直接 API Provider（预留）",
      hint: "只保存未来直接 API 注册；不进入 App Server 或 /model",
    });
  });

  it("renders Setup provider and channel status without exposing credentials", async () => {
    const output: string[] = [];
    const summary = await writeSetupConfigurationSummary({
      environment: {},
      output: { write: (value: string) => output.push(value) },
      loadGatewayDocument: () => ({
        configPath: "/private/config.toml",
        document: {
          telegram: {
            bot_token: "telegram-secret",
            allowed_user_ids: [123456],
          },
          api_providers: [{
            id: "relay-a",
            name: "Relay A",
            protocol: "responses",
            endpoint: "https://api-secret.example/v1/responses",
          }],
        },
      }),
      loadProviderState: async () => ({
        configVersion: "v1",
        defaults: { model: "gpt-5.6-sol", reasoningEffort: "medium" },
        primary: {
          id: "openai",
          displayName: "OpenAI 官方",
          kind: "official",
          mode: "official",
        },
        managedProviders: [{
          id: "deepseek",
          displayName: "DeepSeek",
          kind: "managed",
          model: "deepseek-v4-flash-vision-exp",
          reasoningEffort: "high",
          mode: "switching",
          models: [],
        }],
        customProviders: {
          fixedCandidates: [],
          switchingProviders: [{
            id: "codeproxy",
            displayName: "Code Proxy Injected",
            kind: "custom",
            mode: "switching",
            model: "gpt-5.6-sol",
            reasoningEffort: "medium",
            baseUrl: "https://secret.example/v1",
            profileName: "sf-custom-codeproxy",
          }],
          backupCandidates: [],
        },
        switchingProviders: [
          {
            id: "deepseek",
            displayName: "DeepSeek",
            kind: "managed",
            model: "deepseek-v4-flash-vision-exp",
            reasoningEffort: "high",
            mode: "switching",
            models: [],
          },
          {
            id: "codeproxy",
            displayName: "Code Proxy Injected",
            kind: "custom",
            mode: "switching",
            model: "gpt-5.6-sol",
            reasoningEffort: "medium",
            baseUrl: "https://secret.example/v1",
            profileName: "sf-custom-codeproxy",
          },
        ],
        externalAgent: {
          status: "configured",
          provider: "deepseek",
          model: "deepseek-v4-pro",
        },
      }),
      loadInstalledSkills: () => ["channel-image"],
    });

    const rendered = output.join("");
    expect(summary.primary).toEqual({
      id: "openai",
      displayName: "OpenAI 官方",
      kind: "official",
      mode: "official",
    });
    expect(rendered).toContain("Codex 全局默认值：gpt-5.6-sol · medium");
    expect(rendered).toContain("可切换 Provider：DeepSeek、Code Proxy Injected");
    expect(rendered).toContain("DeepSeek · deepseek-v4-flash-vision-exp · high");
    expect(rendered).toContain("通讯渠道：Telegram（已启用）");
    expect(rendered).toContain("用户技能目录：1 个技能");
    expect(rendered).toContain("共享第三方子代理：deepseek · deepseek-v4-pro");
    expect(rendered).toContain("直接 API Provider（预留）：1 个");
    expect(summary.apiProviderCount).toBe(1);
    expect(rendered).not.toContain("telegram-secret");
    expect(rendered).not.toContain("123456");
    expect(rendered).not.toContain("managed-secret");
    expect(rendered).not.toContain("custom-secret");
    expect(rendered).not.toContain("secret.example");
    expect(rendered).not.toContain("api-secret.example");
    expect(rendered).not.toContain("\u001b");
  });

  it("loads the same Setup summary without requiring a terminal output adapter", async () => {
    const summary = await loadSetupConfigurationSummary({
      environment: {},
      loadGatewayDocument: () => ({
        configPath: "/private/config.toml",
        document: { api_providers: [] },
      }),
      loadProviderState: async () => ({
        configVersion: "v1",
        defaults: { model: "gpt-5.6-sol", reasoningEffort: "medium" },
        primary: {
          id: "openai",
          displayName: "OpenAI 官方",
          kind: "official",
          mode: "official",
        },
        managedProviders: [],
        customProviders: {
          fixedCandidates: [],
          switchingProviders: [],
          backupCandidates: [],
        },
        switchingProviders: [],
        externalAgent: { status: "not-configured" },
      }),
      loadInstalledSkills: () => [],
    });

    expect(summary).toMatchObject({
      primary: {
        id: "openai",
        displayName: "OpenAI 官方",
        kind: "official",
        mode: "official",
      },
      codexDefaults: { model: "gpt-5.6-sol", effort: "medium" },
      switchingProviders: [],
      modelDefaults: [],
      channels: [],
      installedSkillCount: 0,
      agent: { status: "not-configured" },
      apiProviderCount: 0,
      configPath: "/private/config.toml",
    });
  });

  it("renders an unknown primary Provider state without calling it fixed mode", async () => {
    const output: string[] = [];
    await writeSetupConfigurationSummary({
      environment: {},
      output: { write: (value: string) => output.push(value) },
      loadGatewayDocument: () => ({
        configPath: "/private/config.toml",
        document: {},
      }),
      loadProviderState: async () => ({
        configVersion: "v1",
        defaults: { model: null, reasoningEffort: null },
        primary: {
          id: "stale-provider",
          displayName: "stale-provider",
          kind: "unknown",
          mode: "unknown",
        },
        managedProviders: [],
        customProviders: {
          fixedCandidates: [],
          switchingProviders: [],
          backupCandidates: [],
        },
        switchingProviders: [],
        externalAgent: { status: "not-configured" },
      }),
      loadInstalledSkills: () => [],
    });

    expect(output.join("")).toContain("主 Provider：stale-provider（状态未知）");
    expect(output.join("")).not.toContain("stale-provider（固定模式）");
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

  it("returns from a provider module to its submenu before the main Setup menu", async () => {
    const cancel = vi.fn();
    const deepseekSetup = vi.fn(async () => ({ action: "back" }));
    const select = vi.fn()
      .mockResolvedValueOnce("models")
      .mockResolvedValueOnce("third_party")
      .mockResolvedValueOnce("deepseek")
      .mockResolvedValueOnce("back")
      .mockResolvedValueOnce("back")
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
    expect(select).toHaveBeenCalledTimes(6);
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
