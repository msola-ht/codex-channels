import { createHash } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import { ModelSelectionService, type ScheduledTaskUseCases } from "../src/application/index.js";
import type { SessionRouter } from "../src/session-routing/index.js";
import { UserFacingError } from "../src/conversation-core/index.js";
import { InteractionRouter } from "../src/approval/index.js";
import { modelProviderSelectionKeyboard, modelSelectionKeyboard, telegramModelSelectionToken } from "../src/surfaces/telegram/command-renderer.js";
import {
  conversationStatus,
} from "./conversation-command-fixture.js";
import {
  cleanupTelegramSurfaceTestDirectories,
  createTelegramSurfaceFixture,
  scheduledTaskPreview,
  telegramChat,
  telegramPlugin,
  telegramUser,
} from "./telegram-surface-test-fixture.js";

const directories: string[] = [];
const createSurface = createTelegramSurfaceFixture.bind(null, directories);

afterEach(() => {
  cleanupTelegramSurfaceTestDirectories(directories);
});

describe("Telegram command interactions", () => {
  it("orders command replies behind active output in the same chat", async () => {
    const { surface, output, sentTexts } = createSurface(vi.fn(), vi.fn());
    let release!: () => void;
    surface.bot.api.config.use(async (previous, method, payload, signal) => {
      if (method === "sendMessage" && (payload as { text?: string }).text === "先发送") {
        await new Promise<void>(resolve => { release = resolve; });
      }
      return previous(method, payload, signal);
    });
    surface.output.handle({ type: "text.completed",
      target: { surface: "telegram", accountId: "default", conversationId: "100" },
      threadId: "thread", turnId: "turn", itemId: "item", text: "先发送", phase: "final_answer" });
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    const command = surface.bot.handleUpdate({ update_id: 100, message: {
      message_id: 100, date: 1, chat: telegramChat(), from: telegramUser(), text: "/whoami",
      entities: [{ type: "bot_command", offset: 0, length: 7 }],
    } });
    try {
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(sentTexts).toEqual([]);
      release();
      await command;
      expect(sentTexts[0]).toBe("先发送");
      expect(sentTexts[1]).toContain("Telegram 用户 ID");
    } finally {
      release();
      await surface.stop();
      await output.close();
    }
  });

  it("rejects an old marked form at the Bot entry point after restarting", async () => {
    const submit = vi.fn();
    const before = createSurface(submit, vi.fn());
    const target = { surface: "telegram" as const, accountId: "default", conversationId: "100" };
    const decision = before.surface.interactions.request(target, {
      type: "elicitation", mode: "form", requestId: "restart-form", threadId: "old-thread", turnId: "old-turn",
      title: "MCP form", message: "Enter JSON", expiresInMs: 30_000,
    });
    let prompt: string;
    try {
      await vi.waitFor(() => expect(before.sentTexts.length).toBeGreaterThan(0));
      prompt = before.sentTexts[0]!;
    } finally {
      await before.surface.stop();
      await before.output.close();
      await decision;
    }
    const after = createSurface(submit, vi.fn());
    try {
      await after.surface.bot.handleUpdate({ update_id: 1, message: {
        message_id: 100, date: 1, chat: telegramChat(), from: telegramUser(), text: '{"field":"late"}',
        reply_to_message: { message_id: 99, date: 1, chat: telegramChat(), from: { id: 999, is_bot: true, first_name: "Test Bot" },
          text: prompt.replace(/<[^>]+>/g, ""), entities: [{ type: "bold", offset: 0, length: "Codex 交互回复".length }],
          reply_to_message: undefined as never },
      } });
      expect(submit).not.toHaveBeenCalled();
      expect(after.sentTexts.at(-1)).toContain("已失效");
    } finally {
      await after.surface.stop();
      await after.output.close();
    }
  });

  it.each(["cancelled", "resolved", "expired", "completed", "preparing"] as const)(
    "keeps a %s MCP form reply out of ordinary input after switching sessions",
    async (ending) => {
      const submit = vi.fn();
      const newSession = vi.fn().mockResolvedValue({});
      const { surface, output, apiPayloads, sentTexts } = createSurface(submit, vi.fn(), { newSession });
      const target = { surface: "telegram" as const, accountId: "default", conversationId: "100" };
      const router = new InteractionRouter();
      router.register("telegram", "default", surface.interactions);
      let release: (() => void) | undefined;
      if (ending === "preparing") {
        surface.bot.api.config.use(async (previous, method, payload, signal) => {
          if (method === "sendMessage" && !release) {
            await new Promise<void>((resolve) => { release = resolve; });
          }
          return previous(method, payload, signal);
        });
      }
      const reply = (updateId: number, text: string) => surface.bot.handleUpdate({
        update_id: updateId,
        message: {
          message_id: updateId, date: 1, chat: telegramChat(), from: telegramUser(), text,
          reply_to_message: { message_id: 99, date: 1, chat: telegramChat(), text: "MCP form", reply_to_message: undefined as never },
        },
      });
      try {
        const decision = router.request(target, {
          type: "elicitation", mode: "form", requestId: "form-review", threadId: "old-thread", turnId: "old-turn",
          title: "MCP 请求输入", message: "请回复 JSON", expiresInMs: ending === "expired" ? 20 : 30_000,
        });
        if (ending === "preparing") await vi.waitFor(() => expect(release).toBeTypeOf("function"));
        else await vi.waitFor(() => expect(apiPayloads.some(({ method }) => method === "sendMessage")).toBe(true));
        if (ending === "completed") await reply(1, '{"field":"accepted"}');
        else if (ending === "resolved") router.resolved("form-review");
        else if (ending !== "expired") router.cancelThreads(new Set(["old-thread"]));
        await expect(decision).resolves.toEqual({
          type: "elicitation", action: ending === "completed" ? "accept" : "cancel",
          content: ending === "completed" ? { field: "accepted" } : null,
        });
        release?.();
        await vi.waitFor(() => expect(apiPayloads.some(({ method }) => method === "editMessageText")).toBe(true));
        await surface.bot.handleUpdate({
          update_id: 2,
          message: { message_id: 2, date: 1, chat: telegramChat(), from: telegramUser(), text: "/new",
            entities: [{ type: "bot_command", offset: 0, length: 4 }] },
        });
        expect(newSession).toHaveBeenCalledWith(target);
        await reply(3, '{"field":"must-not-reach-new-thread"}');
        expect(submit).not.toHaveBeenCalled();
        expect(sentTexts.at(-1)).toContain("已失效");
      } finally {
        release?.();
        router.cancelAll();
        await surface.stop();
        await output.close();
      }
    },
  );

  it("does not select another account's same-name model when subscription changes during callback acknowledgement", async () => {
    const target = { surface: "telegram" as const, accountId: "default", conversationId: "100" };
    const option = (model: string, provider: string) => ({
      id: model, model, provider, displayName: provider,
      supportedReasoningEfforts: [], defaultReasoningEffort: "high", serviceTiers: [],
      defaultServiceTier: null, isDefault: true, inputModalities: ["text" as const],
    });
    const blocked = new Set<string>();
    const newSession = vi.fn(async () => undefined);
    const router = { modelSettings: () => undefined, workspace: () => ({ cwd: "/workspace" }), newSession } as unknown as SessionRouter;
    const models = new ModelSelectionService({
      listModels: async () => [option("gpt-main", "openai")],
      readDefaultReasoningEffort: async () => null, readDefaultServiceTier: async () => null,
      writeDefaultFastMode: async () => undefined,
    }, router, "gpt-main", [option("shared", "ocg-a"), option("shared", "ocg-b")],
    "openai", [], () => true, () => blocked);
    const state = await models.browseProvider(target, "ocg-a");
    const button = modelSelectionKeyboard({ kind: "models", view: "model", state })!.inline_keyboard[0]![0]!;
    if (!("callback_data" in button)) throw new Error("Expected selection callback");
    const selectModel = vi.fn(models.selectModel.bind(models));
    const { surface, output, sentTexts } = createSurface(vi.fn(), vi.fn(), {
      modelState: models.state.bind(models), selectModel,
    });
    surface.bot.api.config.use(async (previous, method, payload, signal) => {
      if (method === "answerCallbackQuery") {
        blocked.add("ocg-a");
        await models.state(target);
      }
      return previous(method, payload, signal);
    });
    try {
      await surface.bot.handleUpdate({
        update_id: 14,
        callback_query: {
          id: "racing-model-menu", from: telegramUser(), chat_instance: "chat-instance", data: button.callback_data,
          message: { message_id: 23, date: 1, chat: telegramChat(), text: "选择模型" },
        },
      });
      expect(selectModel).toHaveBeenCalledWith(target, { provider: "ocg-a", model: "shared" });
      expect(newSession).not.toHaveBeenCalled();
      expect(models.turnOverrides(target)).toEqual({});
      expect(sentTexts.join("\n")).toContain("/model");
    } finally {
      await surface.stop();
      await output.close();
    }
  });

  it.each(["provider", "model"])("rejects an old %s button after subscription filtering changes its index", async (view) => {
    const models = ["openai", "ocg-a", "ocg-b"].map((provider) => ({
      id: `${provider}-model`, model: `${provider}-model`, provider, displayName: provider,
      supportedReasoningEfforts: [], defaultReasoningEffort: "high", serviceTiers: [],
      defaultServiceTier: null, isDefault: true, inputModalities: ["text" as const],
    }));
    const current = {
      models: [models[0]!, models[2]!], model: "openai-model", modelProvider: "openai",
      effort: "high", serviceTier: null, pending: false, modelPending: false,
      effortPending: false, serviceTierPending: false,
    };
    const before = view === "provider" ? { ...current, models }
      : { ...current, models: [models[1]!], providerFilter: "ocg-a" };
    const result = { kind: "models" as const, view: "model" as const, state: before };
    const keyboard = view === "provider" ? modelProviderSelectionKeyboard(result) : modelSelectionKeyboard(result);
    const button = keyboard!.inline_keyboard[view === "provider" ? 1 : 0]![0]!;
    if (!("callback_data" in button)) throw new Error("Expected selection callback");
    const selectModel = vi.fn().mockResolvedValue(current);
    const browseProviderModels = vi.fn().mockResolvedValue(current);
    const { surface, output, sentTexts } = createSurface(vi.fn(), vi.fn(), {
      modelState: vi.fn().mockResolvedValue(current), selectModel, browseProviderModels,
    });
    try {
      await surface.bot.handleUpdate({
        update_id: 12,
        callback_query: {
          id: "expired-model-menu", from: telegramUser(), chat_instance: "chat-instance",
          data: button.callback_data,
          message: { message_id: 21, date: 1, chat: telegramChat(), text: "旧模型菜单" },
        },
      });
      expect(selectModel).not.toHaveBeenCalled();
      expect(browseProviderModels).not.toHaveBeenCalled();
      expect(sentTexts.join("\n")).toContain("/model");
      const freshResult = { ...result, state: current };
      const freshKeyboard = view === "provider" ? modelProviderSelectionKeyboard(freshResult) : modelSelectionKeyboard(freshResult);
      const freshButton = freshKeyboard!.inline_keyboard[view === "provider" ? 1 : 0]![0]!;
      if (!("callback_data" in freshButton)) throw new Error("Expected selection callback");
      await surface.bot.handleUpdate({
        update_id: 13,
        callback_query: {
          id: "current-model-menu", from: telegramUser(), chat_instance: "chat-instance",
          data: freshButton.callback_data,
          message: { message_id: 22, date: 1, chat: telegramChat(), text: "新模型菜单" },
        },
      });
      expect(view === "provider" ? browseProviderModels : selectModel).toHaveBeenCalledWith(
        { surface: "telegram", accountId: "default", conversationId: "100" },
        view === "provider" ? "ocg-b" : { provider: "openai", model: "openai-model" },
      );
    } finally {
      await surface.stop();
      await output.close();
    }
  });

  it("maps Telegram commands through the shared application command service", async () => {
    const submit = vi.fn();
    const download = vi.fn();
    const newSession = vi.fn().mockResolvedValue({});
    const { surface, output, apiCalls } = createSurface(submit, download, { newSession });

    await surface.bot.handleUpdate({
      update_id: 5,
      message: {
        message_id: 14,
        date: 1,
        from: telegramUser(),
        chat: telegramChat(),
        text: "/new",
        entities: [{ offset: 0, length: 4, type: "bot_command" }],
      },
    });

    expect(newSession).toHaveBeenCalledWith({
      surface: "telegram",
      accountId: "default",
      conversationId: "100",
    });
    expect(apiCalls).toContain("sendMessage");
    await surface.stop();
    await output.close();
  });

  it("uses the shared Skill list and explicit invocation commands", async () => {
    const listSkills = vi.fn(async () => [{
      name: "systematic-debugging",
      description: "系统化排查",
    }]);
    const invokeSkill = vi.fn(async () => ({
      threadId: "thread-1",
      turnId: "turn-1",
      steered: false,
      skillName: "systematic-debugging",
    }));
    const { surface, output, sentTexts } = createSurface(
      vi.fn(),
      vi.fn(),
      { listSkills, invokeSkill },
    );

    await surface.bot.handleUpdate({
      update_id: 60,
      message: {
        message_id: 60,
        date: 1,
        from: telegramUser(),
        chat: telegramChat(),
        text: "/skill",
        entities: [{ offset: 0, length: 6, type: "bot_command" }],
      },
    });
    await surface.bot.handleUpdate({
      update_id: 61,
      message: {
        message_id: 61,
        date: 1,
        from: telegramUser(),
        chat: telegramChat(),
        text: "/skill systematic-debugging 排查微信断线",
        entities: [{ offset: 0, length: 6, type: "bot_command" }],
      },
    });

    expect(sentTexts.some((text) =>
      text.includes("1. systematic-debugging")
    )).toBe(true);
    expect(invokeSkill).toHaveBeenCalledWith(
      { surface: "telegram", accountId: "default", conversationId: "100" },
      "systematic-debugging",
      "排查微信断线",
    );
    await surface.stop();
    await output.close();
  });

  it("accepts the documented shared command shortcuts", async () => {
    const selectWorkspace = vi.fn().mockResolvedValue({
      id: "main",
      name: "Main",
      cwd: "/workspace",
    });
    const resume = vi.fn().mockResolvedValue("thread-1");
    const { surface, output, sentTexts } = createSurface(
      vi.fn(),
      vi.fn(),
      {
        listWorkspaces: () => [{
          id: "main",
          name: "Main",
          cwd: "/workspace",
        }],
        status: () => conversationStatus({
          model: "gpt-test",
          modelProvider: "openai",
        }),
        selectWorkspace,
        resume,
      },
    );

    for (const [index, text] of ["/h", "/work main", "/r thread-1"].entries()) {
      await surface.bot.handleUpdate({
        update_id: 50 + index,
        message: {
          message_id: 50 + index,
          date: 1,
          from: telegramUser(),
          chat: telegramChat(),
          text,
          entities: [{ offset: 0, length: text.split(" ")[0]!.length, type: "bot_command" }],
        },
      });
    }

    expect(sentTexts.join("\n")).toContain("快捷命令：");
    expect(selectWorkspace).toHaveBeenCalledWith(
      { surface: "telegram", accountId: "default", conversationId: "100" },
      "main",
    );
    expect(resume).toHaveBeenCalledWith(
      { surface: "telegram", accountId: "default", conversationId: "100" },
      "thread-1",
    );
    await surface.stop();
    await output.close();
  });

  it("does not let lookalike or other-bot whoami commands bypass authorization", async () => {
    const submit = vi.fn().mockResolvedValue({
      threadId: "thread-1",
      turnId: "turn-1",
      steered: false,
    });
    const { surface, output } = createSurface(submit, vi.fn());
    const unauthorized = { ...telegramUser(), id: 456 };

    await surface.bot.handleUpdate({
      update_id: 6,
      message: {
        message_id: 15,
        date: 1,
        from: unauthorized,
        chat: telegramChat(),
        text: "/whoamix",
        entities: [{ offset: 0, length: 8, type: "bot_command" }],
      },
    });
    await surface.bot.handleUpdate({
      update_id: 7,
      message: {
        message_id: 16,
        date: 1,
        from: unauthorized,
        chat: telegramChat(),
        text: "/whoami@other_bot",
        entities: [{ offset: 0, length: 17, type: "bot_command" }],
      },
    });

    expect(submit).not.toHaveBeenCalled();
    await surface.stop();
    await output.close();
  });

  it("hides unexpected service errors from Telegram replies", async () => {
    const submit = vi.fn().mockRejectedValue(
      new Error("upstream failed with TOKEN=top-secret"),
    );
    const { surface, output, sentTexts } = createSurface(submit, vi.fn());

    await surface.bot.handleUpdate({
      update_id: 8,
      message: {
        message_id: 17,
        date: 1,
        from: telegramUser(),
        chat: telegramChat(),
        text: "执行任务",
      },
    });

    expect(sentTexts).toContain("操作失败：Gateway 未能完成请求，请稍后重试。");
    expect(sentTexts.join("\n")).not.toContain("top-secret");
    await surface.stop();
    await output.close();
  });

  it("keeps explicitly user-facing validation errors actionable", async () => {
    const rename = vi.fn().mockRejectedValue(
      new UserFacingError(
        "conversation.name.invalid",
        "this fallback must not be rendered",
      ),
    );
    const { surface, output, sentTexts } = createSurface(vi.fn(), vi.fn(), { rename });

    await surface.bot.handleUpdate({
      update_id: 9,
      message: {
        message_id: 18,
        date: 1,
        from: telegramUser(),
        chat: telegramChat(),
        text: "/rename",
        entities: [{ offset: 0, length: 7, type: "bot_command" }],
      },
    });

    expect(sentTexts).toContain("操作失败：会话名称必须为 1–64 个字符。");
    await surface.stop();
    await output.close();
  });

  it("notifies configured recipients about configuration lifecycle changes", async () => {
    const { surface, output, sentTexts } = createSurface(vi.fn(), vi.fn());
    surface.replaceNotificationRecipients(new Set([123]));

    await surface.deliverConfigurationChange({
      action: "reloaded",
      changes: [{ code: "workspace.registry", scope: "global" }],
      addedWorkspaces: [{
        id: "codex-channels",
        name: "codex-channels",
        cwd: "/Users/msola/Documents/GitHub/codex-channels",
      }],
    });
    surface.configurationChanged({
      action: "restarting",
      changes: [{ code: "surface.telegram.token", scope: "telegram" }],
      addedWorkspaces: [],
    });

    await surface.stop();
    expect(sentTexts.join("\n")).toContain("Workspace 已添加");
    expect(sentTexts.join("\n")).toContain("codex-channels");
    expect(sentTexts.join("\n")).toContain("Gateway 配置需要重启");
    expect(sentTexts.join("\n")).toContain("Telegram Bot Token");
    await output.close();
  });

  it("switches Workspace from a notification button through the shared command service", async () => {
    const selectWorkspace = vi.fn().mockResolvedValue({
      id: "docs",
      name: "Docs",
      cwd: "/workspace/docs",
    });
    const { surface, output, apiCalls, sentTexts } = createSurface(
      vi.fn(),
      vi.fn(),
      {
        listWorkspaces: () => [{
          id: "docs",
          name: "Docs",
          cwd: "/workspace/docs",
        }],
        status: () => conversationStatus({
          model: "gpt-test",
          modelProvider: "openai",
        }),
        selectWorkspace,
      },
    );

    await surface.bot.handleUpdate({
      update_id: 10,
      callback_query: {
        id: "workspace-switch",
        from: telegramUser(),
        chat_instance: "chat-instance",
        data: `ws:${createHash("sha256").update("docs").digest("base64url")}`,
        message: {
          message_id: 20,
          date: 1,
          chat: telegramChat(),
          text: "Workspace 已添加",
        },
      },
    });

    expect(selectWorkspace).toHaveBeenCalledWith(
      { surface: "telegram", accountId: "default", conversationId: "100" },
      "docs",
    );
    expect(apiCalls).toContain("answerCallbackQuery");
    expect(sentTexts.join("\n")).toContain("已切换 Workspace");
    await surface.stop();
    await output.close();
  });

  it("applies a reasoning effort selected from the post-model buttons", async () => {
    const state = {
      models: [{
        id: "gpt-test",
        model: "gpt-test",
        displayName: "GPT Test",
        supportedReasoningEfforts: [
          { effort: "medium", description: "Medium" },
          { effort: "high", description: "High" },
        ],
        defaultReasoningEffort: "medium",
        serviceTiers: [],
        defaultServiceTier: null,
        isDefault: true,
        inputModalities: ["text" as const],
      }],
      model: "gpt-test",
      modelProvider: "openai",
      effort: "medium",
      serviceTier: null,
      pending: true,
      modelPending: true,
      effortPending: true,
      serviceTierPending: false,
    };
    const selectEffort = vi.fn().mockResolvedValue({ ...state, effort: "high" });
    const { surface, output, apiCalls, sentTexts } = createSurface(
      vi.fn(),
      vi.fn(),
      {
        modelState: vi.fn().mockResolvedValue(state),
        selectEffort,
      },
    );

    await surface.bot.handleUpdate({
      update_id: 11,
      callback_query: {
        id: "model-effort",
        from: telegramUser(),
        chat_instance: "chat-instance",
        data: `me:2:${telegramModelSelectionToken(state)}`,
        message: {
          message_id: 20,
          date: 1,
          chat: telegramChat(),
          text: "选择思考等级",
        },
      },
    });

    expect(selectEffort).toHaveBeenCalledWith(
      { surface: "telegram", accountId: "default", conversationId: "100" },
      "high",
    );
    expect(apiCalls).toContain("editMessageReplyMarkup");
    expect(sentTexts.join("\n")).toContain("high（下一次 Turn 生效）");
    await surface.stop();
    await output.close();
  });

  it("collects a selected Plugin task through one exact ForceReply message", async () => {
    const invokePlugin = vi.fn().mockResolvedValue({
      threadId: "thread-1",
      turnId: "turn-1",
      steered: false,
      pluginName: "GitHub",
    });
    const { surface, output, apiCalls, apiPayloads } = createSurface(
      vi.fn(),
      vi.fn(),
      {
        listPlugins: vi.fn().mockResolvedValue({
          plugins: [
            telegramPlugin("slack@local", "slack", "Slack"),
            telegramPlugin("github@local", "github", "GitHub"),
          ],
          loadErrorCount: 0,
        }),
        invokePlugin,
      },
    );

    await surface.bot.handleUpdate({
      update_id: 11,
      callback_query: {
        id: "plugin-select",
        from: telegramUser(),
        chat_instance: "chat-instance",
        data: "plugin:select:KJV9Ut1pei2MHRjX-Hp6Eak7zSnaNGeVAK2Bhk0mAMA",
        message: {
          message_id: 20,
          date: 1,
          chat: telegramChat(),
          text: "Plugin 列表",
        },
      },
    });
    await surface.bot.handleUpdate({
      update_id: 12,
      message: {
        message_id: 21,
        date: 1,
        from: telegramUser(),
        chat: telegramChat(),
        text: "检查当前 PR",
        reply_to_message: {
          message_id: 99,
          date: 1,
          chat: telegramChat(),
          text: "已选择 GitHub",
          reply_to_message: undefined as never,
        },
      },
    });

    expect(apiPayloads).toContainEqual(expect.objectContaining({
      method: "sendMessage",
      payload: expect.objectContaining({
        reply_markup: { force_reply: true, selective: true },
      }),
    }));
    expect(apiCalls.indexOf("answerCallbackQuery")).toBeLessThan(
      apiCalls.indexOf("sendMessage"),
    );
    expect(invokePlugin).toHaveBeenCalledWith(
      { surface: "telegram", accountId: "default", conversationId: "100" },
      "github@local",
      "检查当前 PR",
    );
    await surface.stop();
    await output.close();
  });

  it("pages the current Plugin catalog through a Telegram callback", async () => {
    const plugins = Array.from({ length: 10 }, (_, index) =>
      telegramPlugin(
        `plugin-${index + 1}@local`,
        `plugin-${index + 1}`,
        `Plugin ${index + 1}`,
      ));
    const { surface, output, apiCalls, sentTexts } = createSurface(
      vi.fn(),
      vi.fn(),
      {
        listPlugins: vi.fn().mockResolvedValue({
          plugins,
          loadErrorCount: 0,
        }),
      },
    );

    await surface.bot.handleUpdate({
      update_id: 14,
      callback_query: {
        id: "plugin-page",
        from: telegramUser(),
        chat_instance: "chat-instance",
        data: "plugin:page:2",
        message: {
          message_id: 23,
          date: 1,
          chat: telegramChat(),
          text: "Plugin 列表",
        },
      },
    });

    expect(apiCalls).toContain("answerCallbackQuery");
    expect(sentTexts.join("\n")).toContain("Plugin 9");
    expect(sentTexts.join("\n")).toContain("Plugin 10");
    await surface.stop();
    await output.close();
  });

  it("opens a Queue item and requires delete confirmation before deletion", async () => {
    const item = {
      id: "01a02373-1bd5-7661-aa48-fc0ff087f0d8",
      clientUserMessageId: "client-queue-1",
      inputType: "text" as const,
      textPreview: "继续检查 Queue 按钮",
      editable: true,
    };
    const queueList = vi.fn(async () => ({
      items: [item],
      selectors: ["1"],
      page: 1,
      pageCount: 1,
      totalItemCount: 1,
    }));
    const queueDelete = vi.fn(async () => ({ deleted: true }));
    const { surface, output, apiCalls, sentTexts } = createSurface(
      vi.fn(),
      vi.fn(),
      { queueList, queueDelete },
    );

    await surface.bot.handleUpdate({
      update_id: 17,
      callback_query: {
        id: "queue-item",
        from: telegramUser(),
        chat_instance: "chat-instance",
        data: `queue:item:1:${item.id}`,
        message: {
          message_id: 26,
          date: 1,
          chat: telegramChat(),
          text: "App Server Queue",
        },
      },
    });
    expect(queueList).toHaveBeenCalledWith(
      { surface: "telegram", accountId: "default", conversationId: "100" },
      1,
    );
    expect(sentTexts.join("\n")).toContain("请选择操作");
    expect(apiCalls).toContain("answerCallbackQuery");

    await surface.bot.handleUpdate({
      update_id: 18,
      callback_query: {
        id: "queue-delete-confirm",
        from: telegramUser(),
        chat_instance: "chat-instance",
        data: `queue:delete-confirm:1:${item.id}`,
        message: {
          message_id: 27,
          date: 1,
          chat: telegramChat(),
          text: "Queue 条目",
        },
      },
    });
    expect(sentTexts.join("\n")).toContain("确认删除 Queue 条目");
    expect(queueDelete).not.toHaveBeenCalled();

    await surface.bot.handleUpdate({
      update_id: 19,
      callback_query: {
        id: "queue-delete",
        from: telegramUser(),
        chat_instance: "chat-instance",
        data: `queue:delete:1:${item.id}`,
        message: {
          message_id: 28,
          date: 1,
          chat: telegramChat(),
          text: "确认删除 Queue 条目？",
        },
      },
    });
    expect(queueDelete).toHaveBeenCalledWith(
      { surface: "telegram", accountId: "default", conversationId: "100" },
      item.id,
    );
    expect(sentTexts.join("\n")).toContain("已删除 App Server Queue 条目");
    await surface.stop();
    await output.close();
  });

  it("confirms a scheduled task from the native Telegram button", async () => {
    const token = "12345678-1234-1234-1234-123456789abc";
    const task = {
      taskId: "task-1",
      name: "每小时检查",
      status: "active" as const,
      schedule: { type: "interval" as const, intervalMinutes: 60, anchorAt: 1 },
      timezone: "Asia/Shanghai",
      nextRunAt: 2,
      workspaceId: "main",
      modelProvider: "openai",
      model: "gpt-5.6-sol",
      reasoningEffort: "medium",
      serviceTier: null,
      sandbox: "workspace-write" as const,
      permissions: null,
      promptPreview: "检查项目",
    };
    const confirm = vi.fn(() => ({ action: "created" as const, task }));
    const { surface, output, apiCalls, sentTexts } = createSurface(
      vi.fn(),
      vi.fn(),
      {},
      vi.fn(),
      vi.fn(),
      undefined,
      false,
      { confirm } as unknown as ScheduledTaskUseCases,
    );

    await surface.bot.handleUpdate({
      update_id: 20,
      callback_query: {
        id: "schedule-confirm",
        from: telegramUser(),
        chat_instance: "chat-instance",
        data: `schedule:confirm:${token}`,
        message: {
          message_id: 30,
          date: 1,
          chat: telegramChat(),
          text: "计划任务创建预览",
        },
      },
    });

    expect(confirm).toHaveBeenCalledWith(
      { surface: "telegram", accountId: "default", conversationId: "100" },
      "123",
      token,
    );
    expect(apiCalls).toContain("answerCallbackQuery");
    expect(apiCalls).toContain("editMessageReplyMarkup");
    expect(sentTexts.join("\n")).toContain("已创建 Gateway 计划任务");
    await surface.stop();
    await output.close();
  });

  it("presents a schedule_task preview with native Telegram buttons", async () => {
    const { surface, output, apiPayloads } = createSurface(vi.fn(), vi.fn());
    const preview = scheduledTaskPreview();

    await surface.presentScheduledTaskConfirmation(
      { surface: "telegram", accountId: "default", conversationId: "100" },
      "123",
      preview,
    );

    const sent = apiPayloads.find(({ method }) => method === "sendMessage");
    expect(sent?.payload.reply_markup).toEqual({
      inline_keyboard: [[
        {
          text: "确认",
          callback_data: `schedule:confirm:${preview.token}`,
        },
        { text: "取消", callback_data: "schedule:cancel" },
      ]],
    });
    await surface.stop();
    await output.close();
  });

  it("fails closed when a Queue item button no longer resolves", async () => {
    const itemId = "01a02373-1bd5-7661-aa48-fc0ff087f0d8";
    const queueList = vi.fn(async () => ({
      items: [],
      selectors: [],
      page: 1,
      pageCount: 1,
      totalItemCount: 0,
    }));
    const { surface, output, sentTexts } = createSurface(
      vi.fn(),
      vi.fn(),
      { queueList },
    );

    await surface.bot.handleUpdate({
      update_id: 20,
      callback_query: {
        id: "queue-stale",
        from: telegramUser(),
        chat_instance: "chat-instance",
        data: `queue:item:1:${itemId}`,
        message: {
          message_id: 29,
          date: 1,
          chat: telegramChat(),
          text: "App Server Queue",
        },
      },
    });

    expect(sentTexts.join("\n")).toContain("找不到指定 Queue 条目");
    await surface.stop();
    await output.close();
  });

  it("rejects replies to stale Plugin prompts after in-memory state is gone", async () => {
    const submit = vi.fn();
    const { surface, output, sentTexts } = createSurface(submit, vi.fn());

    await surface.bot.handleUpdate({
      update_id: 13,
      message: {
        message_id: 22,
        date: 1,
        from: telegramUser(),
        chat: telegramChat(),
        text: "不要进入普通 Turn",
        reply_to_message: {
          message_id: 99,
          date: 1,
          from: {
            id: 999,
            is_bot: true,
            first_name: "Test Bot",
            username: "test_bot",
          },
          chat: telegramChat(),
          text: "已选择 GitHub。请回复此消息输入任务；提示 10 分钟内有效。",
          reply_to_message: undefined as never,
        },
      },
    });

    expect(submit).not.toHaveBeenCalled();
    expect(sentTexts).toContain("Plugin 任务提示已过期，请重新使用 /plugin 选择。");
    await surface.stop();
    await output.close();
  });
});
